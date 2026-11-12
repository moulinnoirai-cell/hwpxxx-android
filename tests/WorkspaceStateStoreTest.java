package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** JVM tests of the workspace layout store. Synthetic ids/titles only; temp directories only. */
public class WorkspaceStateStoreTest {
    static int checks = 0;
    static void yes(boolean ok, String what) { if (!ok) throw new AssertionError(what); checks++; }
    static void eq(Object a, Object b, String what) { yes(Objects.equals(a, b), what + " expected=" + b + " actual=" + a); }
    static UUID u(int n) { return new UUID(0xabcdef0123456789L, 0x8000000000000000L | n); }
    static String id(int n) { return u(n).toString(); }
    static byte[] read(File f) throws IOException { return Files.readAllBytes(f.toPath()); }
    static void write(File f, String s) throws IOException { Files.write(f.toPath(), s.getBytes(StandardCharsets.US_ASCII)); }
    static String text(File f) throws IOException { return new String(read(f), StandardCharsets.US_ASCII); }
    static List<String> names(File dir) { String[] n = dir.list(); List<String> l = new ArrayList<>(Arrays.asList(n == null ? new String[0] : n)); Collections.sort(l); return l; }

    static WorkspaceModel sample() {
        WorkspaceModel m = new WorkspaceModel();
        for (int i = 1; i <= 4; i++) m.createTab(u(i));
        m.setSplit(true, id(4)); m.select(id(1), id(4)); m.moveBefore(id(4), id(1));
        m.update(id(1), "비밀문서.hwp /sdcard/secret.hwp", true, true, true);
        return m;
    }

    static void roundTripAndContent(File dir) throws Exception {
        File f = new File(dir, "workspace-state");
        WorkspaceStateStore s = new WorkspaceStateStore(f);
        eq(s.load().status, WorkspaceStateStore.Status.ABSENT, "absent first");
        WorkspaceModel m = sample(); s.save(m);
        eq(names(dir), Arrays.asList("workspace-state"), "no temp left after save");
        WorkspaceStateStore.Loaded l = s.load();
        eq(l.status, WorkspaceStateStore.Status.OK, "loads");
        eq(l.model.tabIds(), m.tabIds(), "order restored"); eq(l.model.activeId(), m.activeId(), "active restored");
        eq(l.model.primaryId(), m.primaryId(), "primary"); eq(l.model.secondaryId(), m.secondaryId(), "secondary"); eq(l.model.isSplit(), m.isSplit(), "split");
        eq(l.model.recentIds(), m.recentIds(), "recent restored");
        yes(l.model.tab(id(1)).title.isEmpty() && !l.model.tab(id(1)).dirty, "runtime metadata not persisted");
        // privacy: nothing but ASCII layout lines + uuids
        String t = text(f);
        yes(!t.contains("hwp") && !t.contains("sdcard") && !t.contains("secret") && !t.contains("/") && !t.contains("비밀"), "no names/paths: " + t);
        for (String line : t.split("\n")) yes(line.matches("HWPXXX-WORKSPACE 1|(active|primary|secondary|tab|recent) [0-9a-f-]{36}|secondary -|split [01]|sum [0-9a-f]{64}"), "only opaque line shapes: " + line);
        yes(f.length() < WorkspaceStateStore.MAX_BYTES, "bounded size");
        // 5-tab worst case fits (the current limit)
        WorkspaceModel full = new WorkspaceModel(); for (int i = 1; i <= 8; i++) full.createTab(u(i)); full.setSplit(true, full.activeId());
        eq(full.size(), WorkspaceModel.MAX_TABS, "limit is five");
        s.save(full); yes(f.length() <= WorkspaceStateStore.MAX_BYTES, "5 tabs fit: " + f.length()); eq(s.load().model.size(), 5, "5 tabs reload");
        // A workspace written by an older build with 6-8 tabs is loaded whole (nothing dropped); more is invalid.
        List<String> legacy = new ArrayList<>(); for (int i = 1; i <= 8; i++) legacy.add(id(i));
        Files.write(f.toPath(), WorkspaceStateStore.encode(new WorkspaceModel.State(legacy, id(1), id(1), null, false, null)));
        WorkspaceStateStore.Loaded old = s.load();
        yes(old.status == WorkspaceStateStore.Status.OK && old.model.size() == 8 && old.model.isOverLimit(), "legacy 8-tab workspace restored whole");
        s.save(full); // later checks continue with the current-limit workspace
        // ids stable across a process restart: new store instance on same file
        eq(new WorkspaceStateStore(f).load().model.tabIds(), full.tabIds(), "stable ids after restart");
        // overwrite keeps working and replaces
        s.save(m); eq(s.load().model.tabIds(), m.tabIds(), "overwrite");
        // restored model remains fully functional and stays independent of the file
        WorkspaceModel r = s.load().model; r.removeConfirmed(id(2)); eq(s.load().model.size(), 4, "mutating a loaded model does not touch the file");
        // empty model clears
        s.save(new WorkspaceModel()); yes(!f.exists(), "empty workspace removes state file"); eq(s.load().status, WorkspaceStateStore.Status.ABSENT, "absent after clear");
        yes(s.clear(), "clear when absent");
    }

    static void invalidFiles(File dir) throws Exception {
        File f = new File(dir, "workspace-state");
        WorkspaceStateStore s = new WorkspaceStateStore(f);
        s.save(sample()); String good = text(f);
        List<String> bad = new ArrayList<>();
        bad.add("");                                              // empty
        bad.add(good.substring(0, good.length() / 2));            // torn write
        bad.add(good.substring(0, good.length() - 1));            // missing final newline
        bad.add(good.replace("split 1", "split 0"));              // tampered => checksum
        bad.add(good.replace("tab " + id(2), "tab " + id(2).toUpperCase()));
        bad.add(good.replace("HWPXXX-WORKSPACE 1", "HWPXXX-WORKSPACE 2"));
        bad.add("garbage\n");
        bad.add(good + "tab " + id(5) + "\n");                    // data after checksum
        bad.add("HWPXXX-WORKSPACE 1\n".repeat(200));              // oversize
        bad.add(good.replace("\n", "\r\n"));
        bad.add(good + "\u0000");
        for (int i = 0; i < bad.size(); i++) {
            write(f, bad.get(i));
            WorkspaceStateStore.Loaded l = s.load();
            eq(l.status, WorkspaceStateStore.Status.INVALID, "invalid file #" + i + " rejected"); yes(l.model == null, "no model for invalid #" + i);
            yes(l.reason != null && !l.reason.contains(id(1)), "reason carries no data");
            eq(text(f), bad.get(i), "load never rewrites or deletes #" + i);
        }
        // semantically invalid but checksum-correct content (a buggy writer): hand-craft through encode()
        List<WorkspaceModel.State> semantic = new ArrayList<>();
        List<String> t3 = Arrays.asList(id(1), id(2), id(3));
        semantic.add(new WorkspaceModel.State(t3, id(9), id(1), null, false, null));
        semantic.add(new WorkspaceModel.State(t3, id(1), id(1), id(1), true, null));
        semantic.add(new WorkspaceModel.State(Arrays.asList(id(1), id(1)), id(1), id(1), null, false, null));
        semantic.add(new WorkspaceModel.State(t3, id(3), id(1), id(2), true, null));
        semantic.add(new WorkspaceModel.State(new ArrayList<String>(), id(1), id(1), null, false, null));
        for (int i = 0; i < semantic.size(); i++) {
            Files.write(f.toPath(), WorkspaceStateStore.encode(semantic.get(i)));
            eq(s.load().status, WorkspaceStateStore.Status.INVALID, "semantic invalid #" + i);
        }
        List<String> nineTabs = new ArrayList<>(); for (int i = 1; i <= 9; i++) nineTabs.add(id(i));
        Files.write(f.toPath(), WorkspaceStateStore.encode(new WorkspaceModel.State(nineTabs, id(1), id(1), null, false, null)));
        eq(s.load().status, WorkspaceStateStore.Status.INVALID, "9 tabs invalid");
        // a directory in place of the file is reported, not crashed on or removed
        File d2 = new File(dir, "asdir"); yes(d2.mkdir(), "mkdir");
        yes(new WorkspaceStateStore(d2).load().status != WorkspaceStateStore.Status.OK && d2.isDirectory(), "directory is not state");
    }

    static void quarantine(File dir) throws Exception {
        File f = new File(dir, "workspace-state");
        WorkspaceStateStore s = new WorkspaceStateStore(f);
        yes(s.quarantineInvalid() == null, "nothing to quarantine");
        write(f, "corrupt\n");
        eq(s.load().status, WorkspaceStateStore.Status.INVALID, "invalid");
        File q = s.quarantineInvalid();
        yes(q != null && q.getName().equals("workspace-state.invalid") && !f.exists(), "moved aside"); eq(text(q), "corrupt\n", "bytes preserved");
        eq(s.load().status, WorkspaceStateStore.Status.ABSENT, "fresh start possible");
        s.save(sample()); eq(s.load().status, WorkspaceStateStore.Status.OK, "new workspace saved"); eq(text(q), "corrupt\n", "quarantined copy not overwritten by save");
        yes(s.clear(), "clear"); yes(q.exists(), "clear leaves quarantined evidence");
    }

    static void failureSeam(File dir) throws Exception {
        File f = new File(dir, "workspace-state");
        WorkspaceModel old = sample();
        new WorkspaceStateStore(f).save(old);
        byte[] before = read(f);
        final boolean[] fail = {true}; final int[] calls = {0};
        WorkspaceStateStore s = new WorkspaceStateStore(f, (from, to) -> {
            calls[0]++;
            yes(from.getParent().equals(to.getParent()), "temp is in the target directory (same filesystem)");
            if (fail[0]) throw new IOException("injected");
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
        });
        WorkspaceModel next = new WorkspaceModel(); next.createTab(u(7));
        try { s.save(next); throw new AssertionError("failure not surfaced"); } catch (IOException expected) { checks++; }
        eq(calls[0], 1, "mover used once");
        yes(Arrays.equals(read(f), before), "old state intact after failed commit");
        eq(names(dir), Arrays.asList("workspace-state"), "temp removed after failed commit");
        eq(s.load().model.tabIds(), old.tabIds(), "old workspace still loads");
        fail[0] = false; s.save(next); eq(s.load().model.tabIds(), next.tabIds(), "retry commits"); eq(names(dir), Arrays.asList("workspace-state"), "clean after retry");
        // failure on first ever save leaves no file at all
        File g = new File(dir, "fresh");
        WorkspaceStateStore s2 = new WorkspaceStateStore(g, (a, b) -> { throw new IOException("injected"); });
        try { s2.save(next); throw new AssertionError("failure not surfaced"); } catch (IOException expected) { checks++; }
        yes(!g.exists() && !new File(dir, "fresh.tmp").exists(), "no partial state file");
        // a crash after temp write but before commit leaves a stale temp: it is ignored by load and replaced by next save
        write(new File(dir, "workspace-state.tmp"), "half written");
        eq(new WorkspaceStateStore(f).load().model.tabIds(), next.tabIds(), "stale temp ignored");
        new WorkspaceStateStore(f).save(old); eq(new WorkspaceStateStore(f).load().model.tabIds(), old.tabIds(), "stale temp replaced");
        yes(!new File(dir, "workspace-state.tmp").exists(), "stale temp gone after save");
        // seam is used for quarantine too and a failing quarantine leaves the file alone
        write(f, "bad\n");
        WorkspaceStateStore s3 = new WorkspaceStateStore(f, (a, b) -> { throw new IOException("injected"); });
        try { s3.quarantineInvalid(); throw new AssertionError("failure not surfaced"); } catch (IOException expected) { checks++; }
        eq(text(f), "bad\n", "failed quarantine leaves file");
    }

    static void missingDirectory(File dir) throws Exception {
        File f = new File(new File(dir, "a/b"), "workspace-state");
        WorkspaceStateStore s = new WorkspaceStateStore(f);
        eq(s.load().status, WorkspaceStateStore.Status.ABSENT, "absent in missing dir");
        s.save(sample()); eq(s.load().status, WorkspaceStateStore.Status.OK, "creates parent directories");
    }

    static void concurrent(File dir) throws Exception {
        File f = new File(dir, "workspace-state");
        final WorkspaceStateStore s = new WorkspaceStateStore(f);
        final WorkspaceModel a = sample();
        final WorkspaceModel b = new WorkspaceModel(); b.createTab(u(5)); b.createTab(u(6));
        final Throwable[] error = {null};
        Thread[] ts = new Thread[4];
        for (int i = 0; i < ts.length; i++) {
            final int n = i;
            ts[i] = new Thread(() -> {
                try {
                    for (int k = 0; k < 100; k++) {
                        s.save(n % 2 == 0 ? a : b);
                        WorkspaceStateStore.Loaded l = s.load();
                        if (l.status != WorkspaceStateStore.Status.OK) throw new AssertionError("torn read " + l.status);
                    }
                } catch (Throwable e) { synchronized (error) { error[0] = e; } }
            });
            ts[i].start();
        }
        for (Thread t : ts) t.join();
        yes(error[0] == null, "concurrent save/load always sees a complete state: " + error[0]);
        eq(names(dir), Arrays.asList("workspace-state"), "no temp leaks");
    }

    public static void main(String[] args) throws Exception {
        String[] cases = {"roundTripAndContent", "invalidFiles", "quarantine", "failureSeam", "missingDirectory", "concurrent"};
        for (String c : cases) {
            Path dir = Files.createTempDirectory("ws-state-test");
            try {
                WorkspaceStateStoreTest.class.getDeclaredMethod(c, File.class).invoke(null, dir.toFile());
            } catch (java.lang.reflect.InvocationTargetException e) {
                if (e.getCause() instanceof Exception) throw (Exception) e.getCause();
                throw (Error) e.getCause();
            } finally {
                try (java.util.stream.Stream<Path> w = Files.walk(dir)) { w.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
            }
        }
        System.out.println("WorkspaceStateStoreTest OK (" + checks + " checks)");
    }
}
