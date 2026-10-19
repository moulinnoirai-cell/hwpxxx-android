package kr.offline.hwp;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import java.nio.charset.StandardCharsets;

public class FileStoreTest {
    static int checks=0;
    interface Run {void run()throws Exception;}
    static void rejected(Run r)throws Exception{try{r.run();throw new AssertionError("expected rejection");}catch(IOException expected){checks++;}}
    static void yes(boolean b){if(!b)throw new AssertionError();checks++;}
    static byte[] xmlZip(String xml)throws Exception{ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ZipOutputStream z=new ZipOutputStream(bytes)){for(String name:new String[]{"mimetype","Contents/header.xml","Contents/section0.xml"}){z.putNextEntry(new ZipEntry(name));z.write((name.equals("mimetype")?"application/hwp+zip":xml).getBytes(StandardCharsets.UTF_8));z.closeEntry();}}return bytes.toByteArray();}
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("hwp-file-tests-");FileStore store=new FileStore(Arrays.asList(root.toFile()));byte[] hwp=Files.readAllBytes(Paths.get(args[0])),hwpx=Files.readAllBytes(Paths.get(args[1]));
        try{
            FileStore.validate(hwp,"hwp");FileStore.validate(hwpx,"hwpx");checks+=2;
            FileStore.validate(xmlZip("\ufeff<?xml version=\"1.0\" encoding=\"UTF-8\"?><r>한글</r>"),"hwpx");checks++;
            rejected(()->FileStore.bounded(new ByteArrayInputStream(new byte[20]),16));
            rejected(()->FileStore.validate(xmlZip("<!DOCTYPE r [<!ENTITY ext SYSTEM 'file:///etc/passwd'>]><r>&ext;</r>"),"hwpx"));
            rejected(()->FileStore.validate(xmlZip("<a>"),"hwpx"));
            rejected(()->FileStore.validate(xmlZip("<r>"+"<a>".repeat(140)+"</a>".repeat(140)+"</r>"),"hwpx"));
            rejected(()->FileStore.validate("not hwp!".getBytes(),"hwp"));
            rejected(()->store.resolve(root.resolve("../outside").toString()));
            Files.createDirectories(root.resolve("Android/data"));rejected(()->store.resolve(root.resolve("Android/data").toString()));
            // Windows without developer mode cannot create symlinks; Android and Linux run this check.
            try{Files.createSymbolicLink(root.resolve("shortcut"),root);rejected(()->store.resolve(root.resolve("shortcut/a.hwp").toString()));}
            catch(FileSystemException unsupported){System.out.println("SKIP symlink check: "+unsupported.getClass().getSimpleName());}
            for(String n:new String[]{"","..","../escape","a/b","a\\b"," leading","trailing ","a\nname"})rejected(()->FileStore.name(n));
            File folder=store.createFolder(root.toString(),"검토 폴더");yes(folder.isDirectory());rejected(()->store.createFolder(root.toString(),"검토 폴더"));
            Path original=root.resolve("원본.hwp");store.write(original.toString(),hwp,null,false);yes(Arrays.equals(hwp,Files.readAllBytes(original)));
            rejected(()->store.write(original.toString(),hwp,null,false));yes(Arrays.equals(hwp,Files.readAllBytes(original)));
            rejected(()->store.write(original.toString(),hwp,"stale-hash",true));yes(Arrays.equals(hwp,Files.readAllBytes(original)));
            rejected(()->store.write(original.toString(),new byte[]{1,2,3},FileStore.sha(hwp),true));yes(Arrays.equals(hwp,Files.readAllBytes(original)));
            store.write(original.toString(),hwp,FileStore.sha(hwp),true);yes(Arrays.equals(hwp,Files.readAllBytes(original)));
            File moved=store.move(original.toString(),folder.getPath(),"원본.hwp");yes(!Files.exists(original)&&Arrays.equals(hwp,Files.readAllBytes(moved.toPath())));
            store.write(original.toString(),hwp,null,false);rejected(()->store.move(original.toString(),folder.getPath(),"원본.hwp"));yes(Files.exists(original)&&moved.isFile());
            Path p=root.resolve("검증.hwpx");store.write(p.toString(),hwpx,null,false);yes(Arrays.equals(hwpx,store.read(p.toString())));
            // 0.1.2 behaviour: first in-place HWP save keeps a copy; a changed source or an HWPX makes none.
            File bak=store.backup(original.toString(),FileStore.sha(hwp),"20261019-120000");yes(bak.getName().equals("원본_백업_20261019-120000.hwp")&&Arrays.equals(hwp,Files.readAllBytes(bak.toPath())));
            File bak2=store.backup(original.toString(),FileStore.sha(hwp),"20261019-120000");yes(bak2.getName().equals("원본_백업_20261019-120000-2.hwp"));
            rejected(()->store.backup(original.toString(),"stale-hash","x"));yes(store.backup(p.toString(),FileStore.sha(hwpx),"x")==null);
            // A stored entry hidden from the streaming reader (central directory mismatch) is refused.
            byte[] tampered=hwpx.clone();int cd=-1;for(int i=tampered.length-22;i>=0;i--)if(tampered[i]==0x50&&tampered[i+1]==0x4b&&tampered[i+2]==1&&tampered[i+3]==2){cd=i;break;}
            if(cd>=0){tampered[cd+28]=(byte)(tampered[cd+28]+1);byte[] t=tampered;rejected(()->FileStore.validate(t,"hwpx"));}
            for(Path f:(Iterable<Path>)Files.walk(root)::iterator)yes(!f.getFileName().toString().startsWith(".hwp-offline-"));
            System.out.println("FileStore: "+checks+" checks passed");
        }finally{try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(IOException ignored){}});}}
    }
}
