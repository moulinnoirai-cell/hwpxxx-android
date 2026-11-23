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
    /**
     * Rebuilds an HWPX as plain entries (mimetype stored, the rest raw-deflated) and appends {@code slack} stray bytes inside the compressed
     * size of {@code target}, as rhwp does for pictures carried over from an HWP 5 file. {@code badCrc} breaks that entry's CRC in both headers.
     */
    static byte[] slackZip(byte[] hwpx,String target,int slack,boolean badCrc)throws Exception {
        List<String> names=new ArrayList<>();List<byte[]> plain=new ArrayList<>();
        try(ZipInputStream in=new ZipInputStream(new ByteArrayInputStream(hwpx))){ZipEntry e;while((e=in.getNextEntry())!=null){names.add(e.getName());plain.add(in.readAllBytes());}}
        ByteArrayOutputStream out=new ByteArrayOutputStream(),central=new ByteArrayOutputStream();
        java.util.function.BiConsumer<ByteArrayOutputStream,long[]> le=(o,v)->{for(int i=0;i<(int)v[1];i++)o.write((int)(v[0]>>>(8*i)));};
        for(int i=0;i<names.size();i++){
            byte[] name=names.get(i).getBytes(StandardCharsets.UTF_8),data=plain.get(i),stored;boolean deflate=!names.get(i).equals("mimetype");
            if(deflate){Deflater d=new Deflater(Deflater.DEFAULT_COMPRESSION,true);d.setInput(data);d.finish();ByteArrayOutputStream z=new ByteArrayOutputStream();byte[] buf=new byte[8192];while(!d.finished())z.write(buf,0,d.deflate(buf));d.end();stored=z.toByteArray();}
            else stored=data;
            if(names.get(i).equals(target)){stored=Arrays.copyOf(stored,stored.length+slack);for(int k=0;k<slack;k++)stored[stored.length-1-k]=(byte)(0xa3+k);}
            CRC32 crc=new CRC32();crc.update(data);long c=crc.getValue()^(badCrc&&names.get(i).equals(target)?1:0);long offset=out.size();int method=deflate?8:0;
            for(ByteArrayOutputStream o:new ByteArrayOutputStream[]{out,central}){
                boolean cd=o==central;
                le.accept(o,new long[]{cd?0x02014b50L:0x04034b50L,4});if(cd)le.accept(o,new long[]{20,2});
                for(long[] v:new long[][]{{20,2},{0x800,2},{method,2},{0,2},{0x5a21,2},{c,4},{stored.length,4},{data.length,4},{name.length,2},{0,2}})le.accept(o,v);
                if(cd){for(long[] v:new long[][]{{0,2},{0,2},{0,2},{0,4},{offset,4}})le.accept(o,v);}
                o.write(name);if(!cd)o.write(stored);
            }
        }
        long cdOffset=out.size();out.write(central.toByteArray());
        for(long[] v:new long[][]{{0x06054b50L,4},{0,2},{0,2},{names.size(),2},{names.size(),2},{central.size(),4},{cdOffset,4},{0,2}})le.accept(out,v);
        return out.toByteArray();
    }
    static Map<String,byte[]> entries(byte[] zip)throws Exception {Map<String,byte[]> m=new LinkedHashMap<>();try(ZipInputStream in=new ZipInputStream(new ByteArrayInputStream(zip))){ZipEntry e;while((e=in.getNextEntry())!=null)m.put(e.getName(),in.readAllBytes());}return m;}
    static boolean sameEntries(Map<String,byte[]> a,Map<String,byte[]> b){if(!a.keySet().equals(b.keySet()))return false;for(String k:a.keySet())if(!Arrays.equals(a.get(k),b.get(k)))return false;return true;}

    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("hwp-file-tests-");FileStore store=new FileStore(Arrays.asList(root.toFile()));byte[] hwp=Files.readAllBytes(Paths.get(args[0])),hwpx=Files.readAllBytes(Paths.get(args[1]));
        try{
            FileStore.validate(hwp,"hwp");FileStore.validate(hwpx,"hwpx");checks+=2;
            FileStore.validateForRead(hwp,"hwp");FileStore.validateForRead(hwpx,"hwpx");checks+=2;
            byte[] hwp3="HWP Document File V3.00".getBytes(StandardCharsets.US_ASCII);
            byte[] pdf="%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII);
            FileStore.validateForRead(hwp3,"hwp");FileStore.validateForRead(pdf,"pdf");checks+=2;
            rejected(()->FileStore.validateForRead(Arrays.copyOf(hwp3,hwp3.length-1),"hwp"));
            rejected(()->FileStore.validateForRead("text %PDF-1.7".getBytes(StandardCharsets.US_ASCII),"pdf"));
            rejected(()->FileStore.validate(hwp3,"hwp"));
            Path hwp3Source=Files.write(root.resolve("구형.hwp"),hwp3);
            Path pdfSource=Files.write(root.resolve("가져오기.pdf"),pdf);
            rejected(()->store.write(hwp3Source.toString(),hwp,FileStore.sha(hwp3),true));
            rejected(()->store.write(pdfSource.toString(),pdf,FileStore.sha(pdf),true));
            yes(Arrays.equals(hwp3,Files.readAllBytes(hwp3Source))&&Arrays.equals(pdf,Files.readAllBytes(pdfSource)));
            yes(store.write(root.resolve("구형 (2).hwp").toString(),hwp,null,false).isFile());
            yes(store.write(root.resolve("가져오기.hwpx").toString(),hwpx,null,false).isFile());
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
            // A read-only original is not silently replaced, and only our own abandoned temp files are removed.
            Path readOnly=root.resolve("읽기전용.hwp");store.write(readOnly.toString(),hwp,null,false);readOnly.toFile().setWritable(false);
            if(!readOnly.toFile().canWrite()){rejected(()->store.write(readOnly.toString(),hwp,FileStore.sha(hwp),true));yes(Arrays.equals(hwp,Files.readAllBytes(readOnly)));}
            else System.out.println("SKIP read-only check: this account can write read-only files");
            readOnly.toFile().setWritable(true);
            Path stale=root.resolve(".hwp-offline-12345.tmp"),fresh=root.resolve(".hwp-offline-67890.tmp"),foreign=root.resolve(".hwp-offline-notes.tmp");
            for(Path t:new Path[]{stale,fresh,foreign})Files.write(t,new byte[]{1});
            stale.toFile().setLastModified(System.currentTimeMillis()-FileStore.STALE_TEMP_MS-60000);foreign.toFile().setLastModified(System.currentTimeMillis()-FileStore.STALE_TEMP_MS-60000);
            store.write(root.resolve("새 문서.hwp").toString(),hwp,null,false);
            yes(!Files.exists(stale)&&Files.exists(fresh)&&Files.exists(foreign));Files.delete(fresh);Files.delete(foreign);
            for(Path f:(Iterable<Path>)Files.walk(root)::iterator)yes(!f.getFileName().toString().startsWith(".hwp-offline-"));
            // rhwp's deflate slack: a raw deflate stream that ends a few bytes before the entry's recorded compressed size.
            yes(FileStore.withoutDeflateSlack(hwpx)==null&&FileStore.readable(hwpx,"hwpx")==hwpx&&FileStore.storable(hwpx,"hwpx")==hwpx&&FileStore.storable(hwp,"hwp")==hwp);
            String section="Contents/section0.xml";Map<String,byte[]> plain=entries(hwpx);
            byte[] clean=slackZip(hwpx,section,0,false);FileStore.validate(clean,"hwpx");checks++;yes(FileStore.withoutDeflateSlack(clean)==null);
            byte[] slack=slackZip(hwpx,section,8,false);
            rejected(()->entries(slack)); // what the strict streaming reader sees
            FileStore.validate(slack,"hwpx");FileStore.validateForRead(slack,"hwpx");checks+=2;
            byte[] trimmed=FileStore.readable(slack,"hwpx");
            yes(trimmed!=slack&&trimmed.length==slack.length-8&&Arrays.equals(trimmed,FileStore.withoutDeflateSlack(slack))&&Arrays.equals(trimmed,FileStore.storable(slack,"hwpx")));
            yes(Arrays.equals(trimmed,clean)); // exactly the archive without the stray bytes
            yes(FileStore.withoutDeflateSlack(trimmed)==null&&sameEntries(entries(trimmed),plain));
            Path drafted=root.resolve("복구 대상.hwpx");store.write(drafted.toString(),FileStore.storable(slack,"hwpx"),null,false);yes(Arrays.equals(clean,Files.readAllBytes(drafted)));
            for(byte[] bad:new byte[][]{slackZip(hwpx,section,FileStore.MAX_DEFLATE_SLACK+1,false),slackZip(hwpx,section,8,true),slackZip(hwpx,section,0,true)}){
                yes(FileStore.withoutDeflateSlack(bad)==null);rejected(()->FileStore.validate(bad,"hwpx"));rejected(()->FileStore.readable(bad,"hwpx"));
            }
            // A slack archive whose central directory disagrees with the local headers is not trimmed (and stays refused).
            byte[] disagree=slack.clone();int dir=-1;for(int i=disagree.length-22;i>=0;i--)if(disagree[i]==0x50&&disagree[i+1]==0x4b&&disagree[i+2]==1&&disagree[i+3]==2){dir=i;break;}
            disagree[dir+24]^=1;yes(FileStore.withoutDeflateSlack(disagree)==null);rejected(()->FileStore.validate(disagree,"hwpx"));
            System.out.println("FileStore: "+checks+" checks passed");
        }finally{try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(IOException ignored){}});}}
    }
}
