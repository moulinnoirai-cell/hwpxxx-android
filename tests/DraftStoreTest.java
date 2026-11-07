package kr.offline.hwp;

import java.io.*;
import java.nio.file.*;
import java.util.*;

/** JVM tests for recovery drafts: they are private copies, bounded, validated and never touch user documents. */
public class DraftStoreTest {
    static int checks=0;
    static void yes(boolean b,String what){if(!b)throw new AssertionError(what);checks++;}
    interface Run {void run()throws Exception;}
    static void rejected(Run r,String what)throws Exception{try{r.run();}catch(IOException expected){checks++;return;}throw new AssertionError("expected rejection: "+what);}
    static Map<String,String> info(String name,String format){Map<String,String> m=new HashMap<>();m.put("name",name);m.put("format",format);m.put("path","/storage/emulated/0/문서/"+name);m.put("folder","/storage/emulated/0/문서");return m;}
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("hwp-draft-tests-");byte[] hwp=Files.readAllBytes(Paths.get(args[0])),hwpx=Files.readAllBytes(Paths.get(args[1]));
        try {
            DraftStore drafts=new DraftStore(root.resolve("recovery").toFile());
            String a=DraftStore.key("/storage/emulated/0/문서/가.hwp"),b=DraftStore.key("/storage/emulated/0/문서/나.hwpx");
            yes(DraftStore.validKey(a)&&!a.equals(b),"stable distinct keys");
            drafts.write(a,info("가.hwp","hwp"),hwp);drafts.write(b,info("나.hwpx","hwpx"),hwpx);
            List<Map<String,String>> list=drafts.list();yes(list.size()==2,"two drafts listed");
            yes(Arrays.equals(hwp,drafts.read(a))&&Arrays.equals(hwpx,drafts.read(b)),"bytes round trip");
            Map<String,String> m=drafts.info(a);yes(m.get("name").equals("가.hwp")&&m.get("path").endsWith("가.hwp")&&m.get("sha").equals(FileStore.sha(hwp)),"metadata round trip with Korean names");
            // Rewriting the same document replaces its draft rather than adding one.
            drafts.write(a,info("가.hwp","hwp"),hwp);yes(drafts.list().size()==2,"same key replaces the draft");
            // Unsafe or malformed input never reaches the file system.
            rejected(()->drafts.write("../escape",info("x.hwp","hwp"),hwp),"path-like key");
            rejected(()->drafts.read("../../etc/passwd"),"path-like read");
            rejected(()->drafts.write(a,info("x.hwp","hwp"),new byte[]{1,2,3}),"garbage bytes");
            rejected(()->drafts.write(a,info("x.pdf","pdf"),hwp),"unsupported format");
            yes(Arrays.equals(hwp,drafts.read(a)),"a rejected write keeps the previous draft");
            // Corrupt bytes are detected by checksum and the broken draft is dropped on listing.
            Path file=root.resolve("recovery/"+b+".draft");byte[] broken=Files.readAllBytes(file);broken[100]^=1;Files.write(file,broken);
            rejected(()->drafts.read(b),"checksum mismatch");
            // A half-written draft (bytes without metadata) is never offered.
            Files.write(root.resolve("recovery/"+DraftStore.key("orphan")+".draft"),hwp);
            for(Map<String,String> d:drafts.list())yes(!d.get("key").equals(DraftStore.key("orphan")),"orphan bytes ignored");
            // Count budget: the newest draft always survives.
            for(int i=0;i<DraftStore.MAX_DRAFTS+4;i++){drafts.write(DraftStore.key("doc-"+i),info("d"+i+".hwp","hwp"),hwp);Thread.sleep(3);}
            List<Map<String,String>> after=drafts.list();yes(after.size()<=DraftStore.MAX_DRAFTS,"count bounded: "+after.size());
            yes(after.get(0).get("key").equals(DraftStore.key("doc-"+(DraftStore.MAX_DRAFTS+3))),"newest draft kept first");
            // Expired drafts are removed.
            Path meta=root.resolve("recovery/"+DraftStore.key("doc-"+(DraftStore.MAX_DRAFTS+3))+".meta");
            Properties p=new Properties();try(Reader r=new FileReader(meta.toFile())){p.load(r);}p.setProperty("savedAt",String.valueOf(System.currentTimeMillis()-DraftStore.MAX_AGE_MS-1000));try(Writer w=new FileWriter(meta.toFile())){p.store(w,null);}
            for(Map<String,String> d:drafts.list())yes(!d.get("key").equals(DraftStore.key("doc-"+(DraftStore.MAX_DRAFTS+3))),"expired draft removed");
            // Discarding removes both files and is the only thing that deletes user-visible recovery data.
            String keep=after.get(1).get("key");drafts.delete(keep);yes(!Files.exists(root.resolve("recovery/"+keep+".draft"))&&!Files.exists(root.resolve("recovery/"+keep+".meta")),"discard removes files");
            rejected(()->drafts.read(keep),"deleted draft");
            for(Path f:(Iterable<Path>)Files.walk(root.resolve("recovery"))::iterator)yes(!f.getFileName().toString().startsWith(".draft-"),"no temp files left");
            System.out.println("DraftStore: "+checks+" checks passed");
        } finally {try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(IOException ignored){}});}}
    }
}
