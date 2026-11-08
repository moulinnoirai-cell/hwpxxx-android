package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** JVM tests of the encrypted private state store (document history + recent documents). Synthetic data and throw-away keys only. */
public class PrivateStateStoreTest {
    interface Run { void run() throws Exception; }
    static int checks = 0;
    static void yes(boolean ok, String what) { if (!ok) throw new AssertionError(what); checks++; }
    static void rejected(Run r, String what) throws Exception {
        try { r.run(); } catch (IOException expected) { checks++; return; }
        throw new AssertionError("expected rejection: " + what);
    }
    static SecretKey newKey() throws Exception { KeyGenerator g = KeyGenerator.getInstance("AES"); g.init(256); return g.generateKey(); }
    static byte[] b(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    static byte[] read(File f) throws IOException { return Files.readAllBytes(f.toPath()); }
    static void write(File f, byte[] data) throws IOException { Files.write(f.toPath(), data); }
    static List<File> files(File root, String ns, String suffix) {
        File[] all = new File(root, ns).listFiles(); List<File> out = new ArrayList<>();
        if (all != null) for (File f : all) if (f.getName().endsWith(suffix)) out.add(f);
        Collections.sort(out); return out;
    }
    /** The committed payload generation file of a record (name = <hash>.<generation>.d). */
    static File dataFile(File root, String ns, String id) throws Exception {
        String h = PrivateStateStore.fileName(ns, id); File[] all = new File(root, ns).listFiles(); File found = null;
        for (File f : all) if (f.getName().startsWith(h + ".") && f.getName().endsWith(".d")) { if (found != null) throw new AssertionError("more than one generation for " + id); found = f; }
        return found;
    }
    static int generations(File root, String ns, String id) throws Exception {
        String h = PrivateStateStore.fileName(ns, id); int n = 0; File[] all = new File(root, ns).listFiles();
        if (all != null) for (File f : all) if (f.getName().startsWith(h + ".") && f.getName().endsWith(".d")) n++;
        return n;
    }
    static boolean containsBytes(byte[] hay, byte[] needle) {
        outer: for (int i = 0; i + needle.length <= hay.length; i++) { for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer; return true; }
        return false;
    }
    static void deleteTree(Path p) throws IOException {
        if (!Files.exists(p)) return;
        try (java.util.stream.Stream<Path> w = Files.walk(p)) { w.sorted(Comparator.reverseOrder()).forEach(x -> x.toFile().delete()); }
    }

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("pss-test-");
        try {
            File root = tmp.resolve("state").toFile();
            SecretKey key = newKey();
            PrivateStateStore store = new PrivateStateStore(root, key);
            byte[] secretText = b("스냅샷 본문 SECRET-TEXT-12345");

            // 1. round trip, metadata/payload separation, listing
            store.put("history", "id-1", b("{\"label\":\"첫 이력\"}"), secretText);
            PrivateStateStore.Record r = store.get("history", "id-1");
            yes(r != null && Arrays.equals(r.payload, secretText) && Arrays.equals(r.meta, b("{\"label\":\"첫 이력\"}")), "round trip");
            yes(store.get("history", "missing") == null && store.get("recent", "id-1") == null, "absent record / other namespace is null");
            store.put("history", "id-2", b("m2"), new byte[0]);
            store.put("history", "id-3", b("m3"), b("p3"));
            List<PrivateStateStore.Record> list = store.list("history");
            yes(list.size() == 3 && list.get(0).id.equals("id-3") && list.get(2).id.equals("id-1") && list.get(0).payload == null, "list: newest first, metadata only");
            yes(store.get("history", "id-2").payload.length == 0, "empty payload allowed");
            store.put("history", "id-1", b("m1b"), b("p1b"));
            yes(store.list("history").size() == 3 && Arrays.equals(store.get("history", "id-1").payload, b("p1b")) && store.list("history").get(0).id.equals("id-1"), "same id replaces and becomes newest");

            // 2. nothing readable on disk: names are hashes, content/ids/labels only in ciphertext
            for (File f : files(root, "history", "")) {
                byte[] raw = read(f);
                yes(!containsBytes(raw, b("SECRET-TEXT")) && !containsBytes(raw, b("id-1")) && !containsBytes(raw, b("첫 이력")) && !containsBytes(raw, b("history")), "no plaintext in " + f.getName());
                yes(f.getName().matches("[0-9a-f]{64}(\\.[0-9a-f]{32})?\\.(m|d)"), "opaque file name " + f.getName());
            }
            yes(!new File(root, "history/id-1.m").exists(), "ids are never file names");

            // 3. IV: 12 bytes, fresh for every write, same plaintext gives different ciphertext
            Set<String> ivs = new HashSet<>(); byte[] firstCipher = null; boolean differ = true;
            for (int i = 0; i < 40; i++) {
                store.put("recent", "same", b("same-meta"), b("same-payload"));
                byte[] raw = read(files(root, "recent", ".d").get(0));
                ivs.add(Base64.getEncoder().encodeToString(Arrays.copyOfRange(raw, 5, 17)));
                if (firstCipher == null) firstCipher = raw; else differ &= !Arrays.equals(firstCipher, raw);
            }
            yes(ivs.size() == 40 && differ, "random IV per write (40 unique), ciphertext differs for equal plaintext");
            yes(Arrays.equals(Arrays.copyOf(read(files(root, "recent", ".d").get(0)), 5), new byte[]{'P', 'S', 'S', '2', 1}), "magic + version");

            // 4. tamper: flip a byte in every region of both files; truncation; garbage
            store.put("tamper", "t", b("meta-t"), b("payload-t-0123456789"));
            for (String suffix : new String[]{".m", ".d"}) {
                File f = files(root, "tamper", suffix).get(0); byte[] orig = read(f);
                int[] offsets = {0, 3, 4, 5, 16, 17, 20, orig.length / 2, orig.length - 17, orig.length - 1};
                for (int off : offsets) {
                    byte[] bad = orig.clone(); bad[off] ^= 0x01; write(f, bad);
                    rejected(() -> store.get("tamper", "t"), suffix + " flipped byte at " + off);
                }
                for (int cut : new int[]{0, 4, 5, 16, 17, 33, orig.length - 1}) {
                    write(f, Arrays.copyOf(orig, cut));
                    rejected(() -> store.get("tamper", "t"), suffix + " truncated to " + cut);
                }
                write(f, Arrays.copyOf(orig, orig.length + 1)); rejected(() -> store.get("tamper", "t"), suffix + " extended");
                write(f, new byte[200]); rejected(() -> store.get("tamper", "t"), suffix + " garbage");
                write(f, orig);
                yes(Arrays.equals(store.get("tamper", "t").payload, b("payload-t-0123456789")), "restored file reads again");
            }
            // a tampered metadata file is skipped by list() and counted
            store.put("tamper", "u", b("meta-u"), b("payload-u"));
            File mu = new File(root, "tamper/" + PrivateStateStore.fileName("tamper", "u") + ".m");
            byte[] muRaw = read(mu); byte[] bad = muRaw.clone(); bad[bad.length - 1] ^= 1; write(mu, bad);
            yes(store.list("tamper").size() == 1 && store.lastListCorruptCount() == 1, "list skips and counts a corrupt entry");
            write(mu, muRaw);

            // 5. swapping files between records / namespaces / kinds / generations is detected (AAD + header)
            store.put("swap", "a", b("meta-a"), b("payload-a")); store.put("swap", "b", b("meta-b"), b("payload-b"));
            store.put("other", "a", b("meta-oa"), b("payload-oa"));
            String nameA = PrivateStateStore.fileName("swap", "a"), nameB = PrivateStateStore.fileName("swap", "b");
            File aM = new File(root, "swap/" + nameA + ".m"), aD = dataFile(root, "swap", "a"), bM = new File(root, "swap/" + nameB + ".m"), bD = dataFile(root, "swap", "b");
            byte[] aMraw = read(aM), aDraw = read(aD), bMraw = read(bM), bDraw = read(bD);
            write(aD, bDraw); rejected(() -> store.get("swap", "a"), "payload of another record"); write(aD, aDraw);
            write(aM, bMraw); rejected(() -> store.get("swap", "a"), "metadata of another record"); write(aM, aMraw);
            write(aD, aMraw); rejected(() -> store.get("swap", "a"), "meta file used as payload (kind)"); write(aD, aDraw);
            write(aD, read(dataFile(root, "other", "a"))); rejected(() -> store.get("swap", "a"), "payload from another namespace"); write(aD, aDraw);
            yes(Arrays.equals(store.get("swap", "a").payload, b("payload-a")), "intact after restoring");

            // 6. generations: a payload is never overwritten; stale generations and pointers fail closed
            store.put("stale", "s", b("meta-1"), b("payload-1"));
            File sM = new File(root, "stale/" + PrivateStateStore.fileName("stale", "s") + ".m");
            File gen1 = dataFile(root, "stale", "s"); byte[] oldM = read(sM), oldD = read(gen1);
            store.put("stale", "s", b("meta-2"), b("payload-2"));
            File gen2 = dataFile(root, "stale", "s"); byte[] newM = read(sM), newD = read(gen2);
            yes(!gen1.equals(gen2) && !gen1.exists() && generations(root, "stale", "s") == 1, "the superseded generation is deleted only after the new commit");
            write(gen1, oldD);                                  // an old generation file appearing next to the new one is ignored
            yes(Arrays.equals(store.get("stale", "s").payload, b("payload-2")), "stale generation file is ignored while the new metadata points elsewhere");
            write(gen1, newD); yes(Arrays.equals(store.get("stale", "s").payload, b("payload-2")), "a renamed generation file does not matter either");
            gen1.delete();
            write(sM, oldM); rejected(() -> store.get("stale", "s"), "old metadata pointing at a deleted generation");
            write(gen1, newD); rejected(() -> store.get("stale", "s"), "new payload renamed to the old generation name (AAD/header mismatch)");
            gen1.delete(); write(sM, newM);
            yes(Arrays.equals(store.get("stale", "s").payload, b("payload-2")), "current pair reads");
            write(sM, oldM); write(gen1, oldD); gen2.delete();
            yes(Arrays.equals(store.get("stale", "s").payload, b("payload-1")), "documented limit: whole-record rollback to an older consistent pair is not detectable");

            // 7. wrong key and reopening in a new instance (process restart)
            PrivateStateStore reopened = new PrivateStateStore(root, key);
            yes(Arrays.equals(reopened.get("history", "id-3").payload, b("p3")) && reopened.list("history").size() == 3, "new instance with the same key reads existing records");
            PrivateStateStore wrong = new PrivateStateStore(root, newKey());
            rejected(() -> wrong.get("history", "id-3"), "wrong key on get");
            yes(wrong.list("history").isEmpty() && wrong.lastListCorruptCount() == 3, "wrong key: list shows nothing and counts the records as corrupt");
            rejected(() -> new PrivateStateStore(root, newKey()).get("swap", "b"), "wrong key again");

            // 8. budgets and eviction
            PrivateStateStore q = new PrivateStateStore(tmp.resolve("quota").toFile(), key);
            q.configure("history", 3, 1000, 3000);
            for (int i = 1; i <= 5; i++) q.put("history", "q" + i, b("m"), new byte[300]);
            List<PrivateStateStore.Record> ql = q.list("history");
            yes(ql.size() == 3 && ql.get(0).id.equals("q5") && ql.get(2).id.equals("q3") && q.get("history", "q1") == null, "entry budget evicts the oldest");
            rejected(() -> q.put("history", "big", b("m"), new byte[2000]), "record over the per-record budget");
            yes(q.list("history").size() == 3, "a rejected record changes nothing");
            q.put("history", "wide1", b("m"), new byte[900]); q.put("history", "wide2", b("m"), new byte[900]); q.put("history", "wide3", b("m"), new byte[900]);
            long total = 0; for (File f : files(tmp.resolve("quota").toFile(), "history", "")) total += f.length();
            yes(total <= 3000 && q.list("history").size() <= 3 && q.get("history", "wide3") != null, "byte budget (exact encoded bytes on disk) keeps total bounded, newest survives");
            rejected(() -> q.put("history", "meta-big", new byte[PrivateStateStore.MAX_META_BYTES + 1], new byte[1]), "oversized metadata");
            byte[] longId = new byte[PrivateStateStore.MAX_ID_BYTES + 1]; Arrays.fill(longId, (byte) 'x');
            rejected(() -> q.put("history", new String(longId), b("m"), b("p")), "oversized id");
            rejected(() -> q.put("history", "", b("m"), b("p")), "empty id");

            // 9. ids/namespaces cannot reach outside the root
            for (String ns : new String[]{"../x", "a/b", "", "UPPER", "a b", "x".repeat(33), null}) {
                boolean threw = false; try { store.put(ns, "i", b("m"), b("p")); } catch (IllegalArgumentException e) { threw = true; }
                yes(threw, "bad namespace refused: " + ns);
            }
            store.put("history", "../../etc/passwd", b("m"), b("p"));
            yes(store.get("history", "../../etc/passwd") != null && !new File(tmp.toFile(), "etc").exists(), "a path-like id is just an id (hashed file name)");
            yes(store.get("history", "ünï-코드-id") == null, "unicode id lookup of an absent record is null");
            store.put("history", "ünï-코드-id", b("m"), b("p")); yes(store.get("history", "ünï-코드-id").payload.length == 1, "unicode id round trip");

            // 10. delete / clear / crash leftovers
            yes(store.delete("history", "id-2") && !store.delete("history", "id-2") && store.get("history", "id-2") == null, "delete reports existence and removes it");
            File dir = new File(root, "history");
            write(new File(dir, "deadbeef.tmp"), b("half written"));
            File orphan = new File(dir, "0".repeat(64) + "." + "1".repeat(32) + ".d");
            write(orphan, b("orphan payload generation without committed metadata"));
            store.put("history", "after-crash", b("m"), b("p"));
            yes(!new File(dir, "deadbeef.tmp").exists() && !orphan.exists(), "put sweeps temp files and unreferenced payload generations");
            yes(files(root, "history", ".tmp").isEmpty(), "no temp files remain after writes");
            store.clear("history");
            yes(store.list("history").isEmpty() && files(root, "history", "").isEmpty() && store.get("recent", "same") != null, "clear removes one namespace only");
            store.clear("never-used"); yes(!store.delete("never-used", "x") && store.list("never-used").isEmpty(), "unused namespace is harmless");

            // 10b. DURABILITY: failure injection at every step of a replacement; the previous committed record and all others survive
            SecureRandom rnd2 = new SecureRandom();
            File droot = tmp.resolve("durable").toFile();
            PrivateStateStore base = new PrivateStateStore(droot, key);
            base.configure("history", 3, 100_000, 10_000_000);
            base.put("history", "old1", b("meta-old1"), b("payload-old1")); base.put("history", "old2", b("meta-old2"), b("payload-old2")); base.put("history", "old3", b("meta-old3"), b("payload-old3"));
            byte[] snapM = read(new File(droot, "history/" + PrivateStateStore.fileName("history", "old2") + ".m")), snapD = read(dataFile(droot, "history", "old2"));
            // (a) the metadata move (commit) fails AFTER the new payload generation was persisted
            PrivateStateStore failMeta = new PrivateStateStore(droot, key, rnd2, (from, to) -> { if (to.getName().endsWith(".m")) throw new IOException("injected: commit rename failed"); Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); });
            failMeta.configure("history", 3, 100_000, 10_000_000);
            rejected(() -> failMeta.put("history", "old2", b("meta-NEW"), b("payload-NEW")), "commit rename fails");
            PrivateStateStore after = new PrivateStateStore(droot, key);       // process reopen
            PrivateStateStore.Record o2 = after.get("history", "old2");
            yes(o2 != null && Arrays.equals(o2.payload, b("payload-old2")) && Arrays.equals(o2.meta, b("meta-old2")), "after a failed commit the OLD record is unchanged (reopened store)");
            yes(Arrays.equals(read(new File(droot, "history/" + PrivateStateStore.fileName("history", "old2") + ".m")), snapM) && Arrays.equals(read(dataFile(droot, "history", "old2")), snapD), "old metadata and old payload files are byte-identical");
            yes(generations(droot, "history", "old2") == 1 && files(droot, "history", ".tmp").isEmpty(), "only the never-referenced new generation was removed");
            yes(after.list("history").size() == 3 && Arrays.equals(after.get("history", "old1").payload, b("payload-old1")) && Arrays.equals(after.get("history", "old3").payload, b("payload-old3")), "other records survive");
            // (b) the first step (payload move) fails
            PrivateStateStore failData = new PrivateStateStore(droot, key, rnd2, (from, to) -> { if (to.getName().endsWith(".d")) throw new IOException("injected: payload rename failed"); Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); });
            failData.configure("history", 3, 100_000, 10_000_000);
            rejected(() -> failData.put("history", "old2", b("meta-NEW"), b("payload-NEW")), "payload rename fails (replacement)");
            rejected(() -> failData.put("history", "brand-new", b("meta-bn"), b("payload-bn")), "payload rename fails (new record)");
            PrivateStateStore after2 = new PrivateStateStore(droot, key);
            yes(Arrays.equals(after2.get("history", "old2").payload, b("payload-old2")) && after2.get("history", "brand-new") == null && after2.list("history").size() == 3 && files(droot, "history", ".tmp").isEmpty() && generations(droot, "history", "old2") == 1, "first-step failure: old record, other records and directory unchanged");
            // (c) the budget is FULL: a failing new write must not evict anything
            rejected(() -> failMeta.put("history", "brand-new", b("meta-bn"), b("payload-bn")), "full budget + failing commit");
            PrivateStateStore after3 = new PrivateStateStore(droot, key);
            yes(after3.list("history").size() == 3 && after3.get("history", "old1") != null && after3.get("history", "old2") != null && after3.get("history", "old3") != null && after3.get("history", "brand-new") == null, "a failed write with a full budget evicts nothing");
            // (d) a successful commit then prunes the oldest and collects orphans; the old pointer no longer authenticates after tampering
            after3.configure("history", 3, 100_000, 10_000_000);
            after3.put("history", "brand-new", b("meta-bn"), b("payload-bn"));
            yes(after3.list("history").size() == 3 && after3.get("history", "old1") == null && after3.get("history", "brand-new") != null && generations(droot, "history", "old1") == 0, "successful commit evicts the oldest record AFTER committing (metadata and payload generations)");
            write(new File(droot, "history/" + PrivateStateStore.fileName("history", "old2") + ".m"), snapM);
            yes(Arrays.equals(after3.get("history", "old2").payload, b("payload-old2")), "restoring the consistent old pair reads the old version (documented rollback limit)");
            byte[] tamperedM = snapM.clone(); tamperedM[tamperedM.length - 3] ^= 1; write(new File(droot, "history/" + PrivateStateStore.fileName("history", "old2") + ".m"), tamperedM);
            rejected(() -> after3.get("history", "old2"), "tampered pointer fails authentication");
            // a corrupt metadata file must NOT cause its (possibly live) payload to be swept
            after3.put("history", "trigger-sweep", b("m"), b("p"));
            yes(generations(droot, "history", "old2") == 1, "payload referenced by an unreadable metadata file is kept");
            // (e) no atomic move: fail before losing the previous record, no overwrite fallback
            PrivateStateStore noAtomic = new PrivateStateStore(droot, key, rnd2, (from, to) -> { throw new AtomicMoveNotSupportedException(from.getPath(), to.getPath(), "injected: no atomic move"); });
            noAtomic.configure("history", 3, 100_000, 10_000_000);
            rejected(() -> noAtomic.put("history", "trigger-sweep", b("m2"), b("p2")), "atomic move unsupported");
            yes(Arrays.equals(new PrivateStateStore(droot, key).get("history", "trigger-sweep").payload, b("p")) && files(droot, "history", ".tmp").isEmpty(), "unsupported atomic move: previous record intact, no temp files, no copy fallback");
            // (f) exact physical size accounting: the budget is the sum of the encoded files
            PrivateStateStore ex0 = new PrivateStateStore(tmp.resolve("exact0").toFile(), key);
            ex0.put("history", "x", b("0123456789"), new byte[500]);
            long phys = 0; for (File f : files(tmp.resolve("exact0").toFile(), "history", "")) phys += f.length();
            PrivateStateStore ex2 = new PrivateStateStore(tmp.resolve("exact2").toFile(), key); ex2.configure("history", 10, 1000, 2 * phys);
            for (String id : new String[]{"x", "y", "z"}) ex2.put("history", id, b("0123456789"), new byte[500]);
            yes(ex2.list("history").size() == 2 && ex2.get("history", "x") == null, "total budget = exactly two encoded records (" + phys + " bytes each)");
            PrivateStateStore ex1 = new PrivateStateStore(tmp.resolve("exact1").toFile(), key); ex1.configure("history", 10, 1000, 2 * phys - 1);
            for (String id : new String[]{"x", "y", "z"}) ex1.put("history", id, b("0123456789"), new byte[500]);
            yes(ex1.list("history").size() == 1 && ex1.get("history", "z") != null, "one byte less than two records keeps only one");
            rejected(() -> { PrivateStateStore tiny = new PrivateStateStore(tmp.resolve("exact3").toFile(), key); tiny.configure("history", 10, 1000, 1000); tiny.put("history", "x", b("0123456789"), new byte[900]); }, "a record whose encoded size exceeds the total budget is rejected before touching anything");

            // 11. concurrent put/get/delete/list: never torn data, never a wrong payload
            PrivateStateStore c = new PrivateStateStore(tmp.resolve("conc").toFile(), key);
            c.configure("history", 8, 100_000, 5_000_000);
            ExecutorService pool = Executors.newFixedThreadPool(8); AtomicInteger bad2 = new AtomicInteger(), ok = new AtomicInteger();
            List<Future<?>> fs = new ArrayList<>();
            for (int t = 0; t < 8; t++) { final int tt = t; fs.add(pool.submit(() -> {
                Random rnd = new Random(tt);
                for (int i = 0; i < 150; i++) {
                    String id = "k" + rnd.nextInt(6); byte[] body = b(id + ":" + tt + ":" + i);
                    try {
                        switch (rnd.nextInt(4)) {
                            case 0: c.put("history", id, b("meta-" + id), body); break;
                            case 1: { PrivateStateStore.Record x = c.get("history", id); if (x != null) { if (!new String(x.payload, StandardCharsets.UTF_8).startsWith(id + ":") || !new String(x.meta, StandardCharsets.UTF_8).equals("meta-" + id)) bad2.incrementAndGet(); else ok.incrementAndGet(); } break; }
                            case 2: c.delete("history", id); break;
                            default: for (PrivateStateStore.Record x : c.list("history")) if (!new String(x.meta, StandardCharsets.UTF_8).equals("meta-" + x.id)) bad2.incrementAndGet();
                        }
                    } catch (IOException e) { bad2.incrementAndGet(); }
                }
                return null; })); }
            for (Future<?> f : fs) f.get(60, TimeUnit.SECONDS);
            pool.shutdown();
            yes(bad2.get() == 0 && ok.get() > 0, "concurrent put/get/delete/list: no IOException, no torn or foreign data (" + ok.get() + " reads)");
            yes(c.list("history").size() <= 8 && c.lastListCorruptCount() == 0 && files(tmp.resolve("conc").toFile(), "history", ".tmp").isEmpty(), "state stays consistent after the race");

            // 12. no key material handling in the source: never exported, never logged
            String src = new String(Files.readAllBytes(Paths.get(args.length > 0 ? args[0] : "app/src/main/java/kr/offline/hwp/PrivateStateStore.java")), StandardCharsets.UTF_8);
            yes(!src.contains("getEncoded") && !src.contains("System.out") && !src.contains("System.err") && !src.contains("android.util.Log") && !src.contains("printStackTrace"), "source never exports or logs key material");
            yes(!src.contains("SharedPreferences") && !src.contains("getenv") && !src.contains("getProperty"), "source reads no global configuration");
            System.out.println("PrivateStateStore: " + checks + " checks passed");
        } finally { deleteTree(tmp); }
    }
}
