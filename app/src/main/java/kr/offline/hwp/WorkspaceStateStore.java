package kr.offline.hwp;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Atomic persistence of the workspace layout. Stores ONLY opaque tab UUIDs, their order, pane assignment and active/recent ids.
 * Never document names, text, passwords or URI/paths. Loading never modifies or deletes anything; a bad file is reported, not discarded.
 */
public final class WorkspaceStateStore {
    private static final String MAGIC = "HWPXXX-WORKSPACE 1";
    static final int MAX_BYTES = 2048;
    private static final int MAX_LINES = 64;

    /** Atomic-move seam (tests inject failures). */
    public interface Mover { void move(Path from, Path to) throws IOException; }

    public enum Status { ABSENT, OK, INVALID, UNREADABLE }

    public static final class Loaded {
        public final Status status;
        public final WorkspaceModel model;
        public final String reason;
        Loaded(Status status, WorkspaceModel model, String reason) { this.status = status; this.model = model; this.reason = reason; }
    }

    private static final Mover ATOMIC = (from, to) -> {
        try { Files.move(from, to, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException e) { throw new IOException("atomic move unsupported", e); }
    };

    private final File file, temp;
    private final Mover mover;

    public WorkspaceStateStore(File stateFile) { this(stateFile, ATOMIC); }

    public WorkspaceStateStore(File stateFile, Mover mover) {
        if (stateFile == null || mover == null) throw new IllegalArgumentException();
        this.file = stateFile;
        this.temp = new File(stateFile.getParentFile(), stateFile.getName() + ".tmp");
        this.mover = mover;
    }

    public synchronized Loaded load() {
        if (!file.exists()) return new Loaded(Status.ABSENT, null, "no saved workspace");
        byte[] data;
        try {
            if (!file.isFile() || file.length() > MAX_BYTES) return new Loaded(Status.INVALID, null, "state file size");
            data = readAll(file);
        } catch (IOException e) {
            return new Loaded(Status.UNREADABLE, null, "state file unreadable");
        }
        try {
            return new Loaded(Status.OK, WorkspaceModel.restore(parse(data)), "");
        } catch (IllegalArgumentException e) {
            return new Loaded(Status.INVALID, null, "invalid workspace state");
        }
    }

    public synchronized void save(WorkspaceModel model) throws IOException {
        if (model == null) throw new IllegalArgumentException();
        if (model.isEmpty()) { clear(); return; }
        byte[] data = encode(model.exportState());
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("state directory");
        boolean moved = false;
        try {
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(data); out.flush(); out.getFD().sync();
            }
            mover.move(temp.toPath(), file.toPath());
            moved = true;
        } finally {
            if (!moved) temp.delete();
        }
    }

    public synchronized boolean clear() {
        boolean ok = true;
        if (temp.exists()) ok &= temp.delete();
        if (file.exists()) ok &= file.delete();
        return ok;
    }

    public synchronized File quarantineInvalid() throws IOException {
        if (!file.exists()) return null;
        File dest = new File(file.getParentFile(), file.getName() + ".invalid");
        mover.move(file.toPath(), dest.toPath());
        return dest;
    }

    // ---------------------------------------------------------------- format

    static byte[] encode(WorkspaceModel.State s) {
        StringBuilder b = new StringBuilder(MAGIC).append('\n');
        b.append("active ").append(s.activeId).append('\n');
        b.append("primary ").append(s.primaryId).append('\n');
        b.append("secondary ").append(s.secondaryId == null ? "-" : s.secondaryId).append('\n');
        b.append("split ").append(s.split ? '1' : '0').append('\n');
        for (String id : s.tabIds) b.append("tab ").append(id).append('\n');
        for (String id : s.recentIds) b.append("recent ").append(id).append('\n');
        byte[] body = b.toString().getBytes(StandardCharsets.US_ASCII);
        return (b.toString() + "sum " + sha256(body) + "\n").getBytes(StandardCharsets.US_ASCII);
    }

    static WorkspaceModel.State parse(byte[] data) {
        if (data.length == 0 || data.length > MAX_BYTES) throw new IllegalArgumentException("size");
        for (byte x : data) if (x < 0x0a || (x > 0x0a && x < 0x20) || x > 0x7e) throw new IllegalArgumentException("charset");
        String text = new String(data, StandardCharsets.US_ASCII);
        if (!text.endsWith("\n")) throw new IllegalArgumentException("truncated");
        String[] lines = text.substring(0, text.length() - 1).split("\n", -1);
        if (lines.length < 6 || lines.length > MAX_LINES || !MAGIC.equals(lines[0])) throw new IllegalArgumentException("header");
        String last = lines[lines.length - 1];
        if (!last.startsWith("sum ")) throw new IllegalArgumentException("checksum missing");
        int bodyLen = text.length() - last.length() - 1;
        byte[] body = new byte[bodyLen];
        System.arraycopy(data, 0, body, 0, bodyLen);
        if (!sha256(body).equals(last.substring(4))) throw new IllegalArgumentException("checksum");
        String active = null, primary = null, secondary = null, splitText = null;
        boolean haveSecondary = false;
        List<String> tabs = new ArrayList<>(), recent = new ArrayList<>();
        Set<String> single = new HashSet<>();
        for (int i = 1; i < lines.length - 1; i++) {
            String line = lines[i];
            int sp = line.indexOf(' ');
            if (sp <= 0 || sp != line.lastIndexOf(' ')) throw new IllegalArgumentException("line");
            String key = line.substring(0, sp), value = line.substring(sp + 1);
            switch (key) {
                case "tab": tabs.add(value); break;
                case "recent": recent.add(value); break;
                case "active": case "primary": case "secondary": case "split":
                    if (!single.add(key)) throw new IllegalArgumentException("duplicate key");
                    if (key.equals("active")) active = value;
                    else if (key.equals("primary")) primary = value;
                    else if (key.equals("secondary")) { haveSecondary = true; secondary = value.equals("-") ? null : value; }
                    else splitText = value;
                    break;
                default: throw new IllegalArgumentException("unknown key");
            }
        }
        if (active == null || primary == null || !haveSecondary || splitText == null) throw new IllegalArgumentException("missing key");
        if (!splitText.equals("0") && !splitText.equals("1")) throw new IllegalArgumentException("split");
        return new WorkspaceModel.State(tabs, active, primary, secondary, splitText.equals("1"), recent);
    }

    private static String sha256(byte[] data) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x & 0xff));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    private static byte[] readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[512]; int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); if (out.size() > MAX_BYTES) throw new IOException("too large"); }
            return out.toByteArray();
        }
    }
}
