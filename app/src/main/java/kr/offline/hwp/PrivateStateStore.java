package kr.offline.hwp;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * App-private, encrypted key/value state for the shared desktop Studio (document history snapshots, recent documents).
 *
 * Standalone and pure Java: the caller injects the AES key (on Android a non-exportable AndroidKeystore key; this class never extracts
 * the key bytes, never logs, never reads configuration). Every record is two files below {@code root/<namespace>/}:
 * the committed metadata {@code <sha256(ns,id)>.m} and an immutable payload generation {@code <sha256(ns,id)>.<random generation>.d}. File names are opaque hashes; ids, labels and content exist only inside
 * AES-256-GCM ciphertext. Each file is {@code "PSS2" | version | iv(12, random per write) | ciphertext||tag}; the additional authenticated
 * data binds namespace, file hash, kind and version, so files cannot be swapped between records or namespaces. The two files of one write
 * share a random record nonce (= the payload generation) and a sequence number, so a stale or mismatched half is rejected.
 *
 * Durability: a payload generation is NEVER overwritten. A write is: new payload generation (temp file, fsync, atomic rename) then the metadata
 * file (temp file, fsync, atomic rename) which atomically points at that generation = the commit. Until that rename succeeds the previous
 * metadata still points at the previous payload, so a crash or an I/O error at any step leaves the previous committed record (and every other
 * record) intact; only the new, never-referenced generation is deleted. Evicting old records for the budget and deleting the superseded
 * generation happen only AFTER a successful commit. Without atomic-move support a write fails (no copy/overwrite fallback). Budgets
 * (record size, entries, exact encoded bytes on disk in total) evict the oldest records.
 *
 * Known limit: restoring BOTH files of a record to an older consistent pair (whole-record rollback) is not detectable without a hardware
 * monotonic counter.
 */
public final class PrivateStateStore {
    public static final int MAX_ID_BYTES = 256;
    public static final int MAX_META_BYTES = 16 * 1024;
    static final byte[] MAGIC = {'P', 'S', 'S', '2'};
    static final int VERSION = 1, IV_LEN = 12, TAG_BITS = 128, NONCE_LEN = 16;
    private static final byte KIND_META = 'm', KIND_DATA = 'd';

    /** One stored record. {@code payload} is null in {@link #list} results. */
    public static final class Record {
        public final String id;
        public final byte[] meta;
        public final byte[] payload;
        public final long sequence;
        Record(String id, byte[] meta, byte[] payload, long sequence) { this.id = id; this.meta = meta; this.payload = payload; this.sequence = sequence; }
    }

    private static final class Quota {
        final int maxEntries; final long maxRecordBytes, maxTotalBytes;
        Quota(int e, long r, long t) { maxEntries = e; maxRecordBytes = r; maxTotalBytes = t; }
    }

    private static final class Plain {
        String ns, id; byte[] nonce; long sequence; byte kind; byte[] body;
    }

    /** The only way files are published (temp file -> final name). Production = atomic rename; tests inject failures. Must not fall back to copying. */
    public interface Mover { void move(File from, File to) throws IOException; }

    private static final Mover ATOMIC = (from, to) -> Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);

    private final File root;
    private final Mover mover;
    private final SecretKey key;
    private final SecureRandom random;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final Map<String, Quota> quotas = new HashMap<>();
    private volatile int corrupt;

    public PrivateStateStore(File root, SecretKey key) { this(root, key, new SecureRandom()); }

    public PrivateStateStore(File root, SecretKey key, SecureRandom random) { this(root, key, random, ATOMIC); }

    /** Failure-injection constructor for tests: {@code mover} replaces the atomic rename. */
    public PrivateStateStore(File root, SecretKey key, SecureRandom random, Mover mover) {
        if (root == null || key == null || random == null || mover == null) throw new IllegalArgumentException("root, key, random and mover are required");
        this.root = root; this.key = key; this.random = random; this.mover = mover;
    }

    /** Set the budget of a namespace before its first use (default: 32 entries, 32 MiB per record, 256 MiB in total). */
    public void configure(String ns, int maxEntries, long maxRecordBytes, long maxTotalBytes) {
        checkNs(ns);
        if (maxEntries < 1 || maxRecordBytes < 1 || maxTotalBytes < maxRecordBytes) throw new IllegalArgumentException("bad budget");
        lock.writeLock().lock();
        try { quotas.put(ns, new Quota(maxEntries, maxRecordBytes, maxTotalBytes)); } finally { lock.writeLock().unlock(); }
    }

    public void put(String ns, String id, byte[] meta, byte[] payload) throws IOException {
        checkNs(ns); byte[] idBytes = checkId(id);
        if (meta == null || meta.length > MAX_META_BYTES) throw new IOException("메타데이터 크기가 올바르지 않아요.");
        if (payload == null) payload = new byte[0];
        lock.writeLock().lock();
        try {
            Quota q = quota(ns);
            if ((long) meta.length + payload.length > q.maxRecordBytes) throw new IOException("저장할 기록이 너무 커요.");
            File dir = namespaceDir(ns, true);
            String name = fileName(ns, id);
            sweep(ns, dir);                                          // only temp files and unreferenced payload generations
            long next = 1;
            for (Entry e : scan(ns, dir)) next = Math.max(next, e.sequence + 1);
            byte[] nonce = new byte[NONCE_LEN]; random.nextBytes(nonce);
            String gen = hex(nonce);
            byte[] sealedData = seal(ns, name + "." + gen, KIND_DATA, id, idBytes, nonce, next, payload);
            byte[] sealedMeta = seal(ns, name, KIND_META, id, idBytes, nonce, next, meta);
            if ((long) sealedData.length + sealedMeta.length > q.maxTotalBytes) throw new IOException("저장할 기록이 총 용량을 넘어요.");
            File newData = new File(dir, name + "." + gen + ".d");
            try {
                writeAtomic(newData, sealedData);                    // 1. new immutable generation (the old one is untouched)
                writeAtomic(new File(dir, name + ".m"), sealedMeta); // 2. COMMIT: the metadata now points at the new generation
            } catch (IOException | RuntimeException failed) {
                // Not committed: the previous metadata (if any) still points at the previous payload. Remove only the never-referenced new generation.
                if (!committed(dir, name, nonce)) newData.delete();
                throw failed;
            }
            syncDir(dir);
            // 3. After a successful commit only: drop superseded generations of this record, then evict the oldest records for the budget.
            deleteOtherGenerations(dir, name, gen);
            evict(ns, dir, q, name);
        } finally { lock.writeLock().unlock(); }
    }

    /** True if the committed metadata of {@code name} carries {@code nonce} (the commit happened even if the move reported a failure afterwards). */
    private boolean committed(File dir, String name, byte[] nonce) {
        try { return Arrays.equals(open(dir.getName(), name, KIND_META, read(new File(dir, name + ".m"))).nonce, nonce); } catch (IOException e) { return false; }
    }

    private void deleteOtherGenerations(File dir, String name, String keepGen) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) { String n = f.getName(); if (n.startsWith(name + ".") && n.endsWith(".d") && !n.equals(name + "." + keepGen + ".d")) f.delete(); }
    }

    /** Budget enforcement AFTER the new record is committed; exact encoded sizes on disk. A failure here never undoes the commit. */
    private void evict(String ns, File dir, Quota q, String keepName) {
        try {
            List<Entry> live = scan(ns, dir);
            Collections.sort(live, (a, b) -> Long.compare(a.sequence, b.sequence));
            long used = 0; int count = live.size();
            for (Entry e : live) used += e.bytes;
            for (Entry e : live) {
                if (count <= q.maxEntries && used <= q.maxTotalBytes) break;
                if (e.name.equals(keepName)) continue;
                removeRecord(dir, e.name); used -= e.bytes; count--;
            }
        } catch (IOException stopped) { /* the budget is enforced again by the next put; the committed record stays */ }
    }

    /** The record, or null if absent. Throws if it was tampered with, truncated, encrypted under another key or is a mismatched pair. */
    public Record get(String ns, String id) throws IOException {
        checkNs(ns); checkId(id);
        lock.readLock().lock();
        try {
            File dir = namespaceDir(ns, false);
            if (dir == null) return null;
            String name = fileName(ns, id);
            File m = new File(dir, name + ".m");
            if (!m.isFile()) return null;
            Plain meta = open(ns, name, KIND_META, read(m));
            if (!meta.id.equals(id)) throw new IOException("기록이 이 항목과 맞지 않아요.");
            String dataName = name + "." + hex(meta.nonce);
            File d = new File(dir, dataName + ".d");
            if (!d.isFile()) throw new IOException("기록의 본문이 없어요.");
            Plain data = open(ns, dataName, KIND_DATA, read(d));
            if (!data.id.equals(id) || !Arrays.equals(meta.nonce, data.nonce) || meta.sequence != data.sequence) throw new IOException("기록의 두 부분이 서로 맞지 않아요.");
            return new Record(id, meta.body, data.body, meta.sequence);
        } finally { lock.readLock().unlock(); }
    }

    /** Records whose metadata authenticates and whose payload file exists (metadata only, newest first); the others are skipped and counted in {@link #lastListCorruptCount}. */
    public List<Record> list(String ns) throws IOException {
        checkNs(ns);
        lock.readLock().lock();
        try {
            File dir = namespaceDir(ns, false);
            List<Record> out = new ArrayList<>(); int bad = 0;
            if (dir != null) for (Entry e : scanAll(ns, dir)) { if (e.record == null) bad++; else out.add(e.record); }
            Collections.sort(out, (a, b) -> Long.compare(b.sequence, a.sequence));
            corrupt = bad;
            return out;
        } finally { lock.readLock().unlock(); }
    }

    public int lastListCorruptCount() { return corrupt; }

    public boolean delete(String ns, String id) throws IOException {
        checkNs(ns); checkId(id);
        lock.writeLock().lock();
        try {
            File dir = namespaceDir(ns, false);
            if (dir == null) return false;
            String name = fileName(ns, id);
            boolean existed = new File(dir, name + ".m").isFile();
            removeRecord(dir, name);
            return existed;
        } finally { lock.writeLock().unlock(); }
    }

    public void clear(String ns) throws IOException {
        checkNs(ns);
        lock.writeLock().lock();
        try {
            File dir = namespaceDir(ns, false);
            if (dir == null) return;
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) if (f.isFile() && !f.delete() && f.exists()) throw new IOException("기록을 지우지 못했어요.");
        } finally { lock.writeLock().unlock(); }
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────

    private static final class Entry {
        String name, gen; long sequence; long bytes; Record record;
    }

    private Quota quota(String ns) { Quota q = quotas.get(ns); return q != null ? q : new Quota(32, 32L << 20, 256L << 20); }

    private static void checkNs(String ns) {
        if (ns == null || !ns.matches("[a-z][a-z0-9-]{0,31}")) throw new IllegalArgumentException("bad namespace");
    }

    private static byte[] checkId(String id) throws IOException {
        if (id == null || id.isEmpty()) throw new IOException("항목 ID가 올바르지 않아요.");
        byte[] b = id.getBytes(StandardCharsets.UTF_8);
        if (b.length > MAX_ID_BYTES) throw new IOException("항목 ID가 너무 길어요.");
        return b;
    }

    private File namespaceDir(String ns, boolean create) throws IOException {
        File dir = new File(root, ns);
        if (dir.isDirectory()) return dir;
        if (!create) return null;
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("비공개 저장 폴더를 만들지 못했어요.");
        dir.setReadable(false, false); dir.setReadable(true, true); dir.setWritable(false, false); dir.setWritable(true, true); dir.setExecutable(false, false); dir.setExecutable(true, true);
        return dir;
    }

    static String fileName(String ns, String id) throws IOException {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            sha.update(ns.getBytes(StandardCharsets.UTF_8)); sha.update((byte) 0); sha.update(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder s = new StringBuilder();
            for (byte b : sha.digest()) s.append(String.format("%02x", b & 255));
            return s.toString();
        } catch (GeneralSecurityException e) { throw new IOException("해시를 계산하지 못했어요."); }
    }

    private byte[] aad(String ns, String name, byte kind) {
        byte[] n = ns.getBytes(StandardCharsets.UTF_8), h = name.getBytes(StandardCharsets.US_ASCII);
        ByteBuffer b = ByteBuffer.allocate(MAGIC.length + 2 + n.length + 1 + h.length);
        b.put(MAGIC).put((byte) VERSION).put(kind).put(n).put((byte) 0).put(h);
        return b.array();
    }

    private byte[] seal(String ns, String name, byte kind, String id, byte[] idBytes, byte[] nonce, long sequence, byte[] body) throws IOException {
        byte[] n = ns.getBytes(StandardCharsets.UTF_8);
        ByteBuffer plain = ByteBuffer.allocate(1 + n.length + 2 + idBytes.length + NONCE_LEN + 8 + 1 + 4 + body.length);
        plain.put((byte) n.length).put(n).putShort((short) idBytes.length).put(idBytes).put(nonce).putLong(sequence).put(kind).putInt(body.length).put(body);
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key);          // the cipher draws a fresh random IV for every encryption (also the Android Keystore rule)
            byte[] iv = c.getIV();
            if (iv == null || iv.length != IV_LEN) throw new IOException("암호화 초기값이 올바르지 않아요.");
            c.updateAAD(aad(ns, name, kind));
            byte[] ct = c.doFinal(plain.array());
            ByteBuffer out = ByteBuffer.allocate(MAGIC.length + 1 + IV_LEN + ct.length);
            out.put(MAGIC).put((byte) VERSION).put(iv).put(ct);
            return out.array();
        } catch (GeneralSecurityException e) { throw new IOException("암호화하지 못했어요."); }
    }

    private Plain open(String ns, String name, byte kind, byte[] file) throws IOException {
        if (file.length < MAGIC.length + 1 + IV_LEN + TAG_BITS / 8) throw new IOException("기록이 잘렸어요.");
        for (int i = 0; i < MAGIC.length; i++) if (file[i] != MAGIC[i]) throw new IOException("알 수 없는 기록 형식이에요.");
        if (file[MAGIC.length] != VERSION) throw new IOException("지원하지 않는 기록 버전이에요.");
        byte[] iv = Arrays.copyOfRange(file, MAGIC.length + 1, MAGIC.length + 1 + IV_LEN);
        byte[] plain;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            c.updateAAD(aad(ns, name, kind));
            plain = c.doFinal(file, MAGIC.length + 1 + IV_LEN, file.length - MAGIC.length - 1 - IV_LEN);
        } catch (GeneralSecurityException e) { throw new IOException("기록이 변조되었거나 키가 맞지 않아요."); }
        try {
            ByteBuffer b = ByteBuffer.wrap(plain);
            Plain p = new Plain();
            byte[] n = new byte[b.get() & 255]; b.get(n); p.ns = new String(n, StandardCharsets.UTF_8);
            byte[] id = new byte[b.getShort() & 0xffff]; b.get(id); p.id = new String(id, StandardCharsets.UTF_8);
            p.nonce = new byte[NONCE_LEN]; b.get(p.nonce); p.sequence = b.getLong(); p.kind = b.get();
            int len = b.getInt();
            if (len < 0 || len != b.remaining()) throw new IOException("기록의 길이가 맞지 않아요.");
            p.body = new byte[len]; b.get(p.body);
            if (!p.ns.equals(ns) || p.kind != kind || !fileName(ns, p.id).equals(name.substring(0, 64))) throw new IOException("기록이 이 위치의 것이 아니에요.");
            if (kind == KIND_DATA && !name.equals(fileName(ns, p.id) + "." + hex(p.nonce))) throw new IOException("기록 세대가 맞지 않아요.");
            return p;
        } catch (java.nio.BufferUnderflowException | IllegalArgumentException e) { throw new IOException("기록 형식이 올바르지 않아요."); }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 255));
        return s.toString();
    }

    private static byte[] read(File f) throws IOException {
        long len = f.length();
        if (len > Integer.MAX_VALUE - 64) throw new IOException("기록이 너무 커요.");
        return Files.readAllBytes(f.toPath());
    }

    private void writeAtomic(File target, byte[] data) throws IOException {
        File tmp = new File(target.getParentFile(), target.getName() + "." + Long.toHexString(random.nextLong()) + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                tmp.setReadable(false, false); tmp.setReadable(true, true); tmp.setWritable(false, false); tmp.setWritable(true, true);
                out.write(data); out.flush(); out.getFD().sync();
            }
            mover.move(tmp, target);
        } finally { if (tmp.exists()) tmp.delete(); }
    }

    private static void syncDir(File dir) {
        try (FileChannel ch = FileChannel.open(dir.toPath(), StandardOpenOption.READ)) { ch.force(true); } catch (IOException | UnsupportedOperationException ignored) { /* best effort: not every file system allows it */ }
    }

    /**
     * Remove half-written temp files and payload generations that no committed metadata references (left by a crash or a failed write).
     * Called under the write lock. A payload is kept when its metadata file exists but cannot be authenticated (never guess: it may be live).
     */
    private void sweep(String ns, File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        Map<String, String> liveGen = new HashMap<>(); Map<String, Boolean> hasMeta = new HashMap<>();
        for (Entry e : scanAll(ns, dir)) { hasMeta.put(e.name, true); if (e.record != null) liveGen.put(e.name, e.gen); }
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(".tmp")) { f.delete(); continue; }
            if (!n.endsWith(".d") || n.length() != 64 + 1 + 32 + 2) continue;
            String base = n.substring(0, 64), gen = n.substring(65, 97);
            if (liveGen.containsKey(base)) { if (!liveGen.get(base).equals(gen)) f.delete(); }
            else if (!hasMeta.containsKey(base)) f.delete();
        }
    }

    private void removeRecord(File dir, String name) throws IOException {
        File m = new File(dir, name + ".m");
        if (m.exists() && !m.delete() && m.exists()) throw new IOException("기록을 지우지 못했어요.");   // metadata first = the commit point
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) { String n = f.getName(); if (n.startsWith(name + ".") && n.endsWith(".d") && !f.delete() && f.exists()) throw new IOException("기록 본문을 지우지 못했어요."); }
    }

    /** Entries with their sequence and on-disk size; corrupt metadata files are not part of the result (used for budgeting). */
    private List<Entry> scan(String ns, File dir) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : scanAll(ns, dir)) if (e.record != null) out.add(e);
        return out;
    }

    private List<Entry> scanAll(String ns, File dir) {
        List<Entry> out = new ArrayList<>();
        File[] files = dir.listFiles();
        if (files == null) return out;
        for (File f : files) {
            String n = f.getName();
            if (!n.endsWith(".m") || n.length() != 66) continue;
            String name = n.substring(0, 64);
            Entry e = new Entry(); e.name = name;
            try {
                Plain p = open(ns, name, KIND_META, read(f));
                e.gen = hex(p.nonce);
                File d = new File(dir, name + "." + e.gen + ".d");
                // Listing decrypts metadata only (payloads can be megabytes); the payload is authenticated and matched to its metadata by get().
                if (!d.isFile() || d.length() < MAGIC.length + 1 + IV_LEN + TAG_BITS / 8) throw new IOException("missing or truncated payload");
                e.sequence = p.sequence; e.bytes = f.length() + d.length();
                e.record = new Record(p.id, p.body, null, p.sequence);
            } catch (IOException bad) { e.record = null; }
            out.add(e);
        }
        return out;
    }
}
