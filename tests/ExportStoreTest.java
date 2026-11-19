package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class ExportStoreTest {
    interface Action {void run()throws Exception;}
    static int checks;
    static void yes(boolean value){if(!value)throw new AssertionError("check "+checks);checks++;}
    static void reject(Action action)throws Exception {try{action.run();throw new AssertionError("expected rejection");}catch(IOException expected){checks++;}}
    static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    static void noTemps(Path root)throws Exception {try(java.util.stream.Stream<Path> list=Files.list(root)){yes(list.noneMatch(path->path.getFileName().toString().startsWith(".hwp-offline-")));}}
    public static void main(String[] arguments)throws Exception {
        Path root=Files.createTempDirectory("studio-export-test-");FileStore files=new FileStore(Collections.singletonList(root.toFile()));ExportStore exports=new ExportStore(files);
        byte[] original=bytes("<?xml version=\"1.0\"?><HWPML><BODY>원본</BODY></HWPML>"),edited=bytes("<HWPML><BODY>편집</BODY></HWPML>");
        Path source=root.resolve("문서.hml");
        try {
            ExportStore.validateDocument(original,"hml");checks++;
            byte[] hwp3=bytes("HWP Document File V3.00");
            ExportStore.validateDocumentForRead(hwp3,"hwp");
            ExportStore.validateDocumentForRead(bytes("%PDF-1.7"),"pdf");checks+=2;
            reject(()->ExportStore.validateDocument(hwp3,"hwp"));
            reject(()->ExportStore.validateDocument(bytes("<!DOCTYPE HWPML [<!ENTITY read SYSTEM 'file:///etc/passwd'>]><HWPML>&read;</HWPML>"),"hml"));
            reject(()->ExportStore.validateDocument(bytes("<html>wrong root</html>"),"hml"));
            reject(()->ExportStore.validateDocument(bytes("<HWPML><a>"),"hml"));
            reject(()->ExportStore.validateDocument(bytes("<HWPML>"+"<a>".repeat(130)+"</a>".repeat(130)+"</HWPML>"),"hml"));
            reject(()->ExportStore.validateExport(new byte[FileStore.MAX_BYTES+1],"x.txt"));
            reject(()->exports.write(root.resolve("../outside.hml").toString(),original,null,false));
            Files.createDirectories(root.resolve("Android/data"));reject(()->exports.write(root.resolve("Android/data/inside.hml").toString(),original,null,false));
            try{Files.createSymbolicLink(root.resolve("shortcut"),root);reject(()->exports.write(root.resolve("shortcut/a.hml").toString(),original,null,false));}catch(FileSystemException unsupported){System.out.println("SKIP symlink check: "+unsupported.getClass().getSimpleName());}
            exports.write(source.toString(),original,null,false);yes(Arrays.equals(original,Files.readAllBytes(source)));
            reject(()->exports.write(source.toString(),edited,null,false));yes(Arrays.equals(original,Files.readAllBytes(source)));noTemps(root);
            reject(()->exports.write(source.toString(),edited,"stale-hash",true));yes(Arrays.equals(original,Files.readAllBytes(source)));noTemps(root);
            reject(()->exports.write(source.toString(),bytes("not XML"),FileStore.sha(original),true));yes(Arrays.equals(original,Files.readAllBytes(source)));noTemps(root);
            File backup=exports.backup(source.toString(),FileStore.sha(original),"20261107-010203");yes(Arrays.equals(original,Files.readAllBytes(backup.toPath())));
            reject(()->exports.backup(source.toString(),"stale","x"));
            // A filesystem refusing atomic replacement must retain original AND backup byte-for-byte.
            ExportStore noAtomic=new ExportStore(files,(from,to)->{throw new AtomicMoveNotSupportedException(from.toString(),to.toString(),"injected unsupported filesystem");});
            reject(()->noAtomic.write(source.toString(),edited,FileStore.sha(original),true));yes(Arrays.equals(original,Files.readAllBytes(source)));yes(Arrays.equals(original,Files.readAllBytes(backup.toPath())));noTemps(root);
            // A different late I/O failure must not produce partial replacement or leftovers.
            ExportStore noWrite=new ExportStore(files,(from,to)->{throw new IOException("injected I/O failure");});
            reject(()->noWrite.write(source.toString(),edited,FileStore.sha(original),true));yes(Arrays.equals(original,Files.readAllBytes(source)));noTemps(root);
            Path failedCopy=root.resolve("failed-copy.hml");reject(()->noWrite.write(failedCopy.toString(),edited,null,false));yes(!Files.exists(failedCopy));noTemps(root);
            Path copy=root.resolve("copy.hml");noAtomic.write(copy.toString(),edited,null,false);yes(Arrays.equals(edited,Files.readAllBytes(copy)));noTemps(root);
            exports.write(source.toString(),edited,FileStore.sha(original),true);yes(Arrays.equals(edited,Files.readAllBytes(source)));yes(Arrays.equals(original,Files.readAllBytes(backup.toPath())));noTemps(root);
            byte[] html=bytes("<!DOCTYPE html><html><body>한글</body></html>");for(String suffix:new String[]{"html","doc"}){Path path=root.resolve("export."+suffix);exports.write(path.toString(),html,null,false);yes(Arrays.equals(html,Files.readAllBytes(path)));reject(()->exports.write(path.toString(),html,FileStore.sha(html),true));}
            reject(()->exports.write(root.resolve("wrong.doc").toString(),bytes("<HWPML/>"),null,false));
            reject(()->exports.write(root.resolve("payload.exe").toString(),html,null,false));
            reject(()->ExportStore.validateExport(bytes("not png"),"x.png"));reject(()->ExportStore.validateExport(new byte[]{(byte)255,(byte)216,0,0},"x.jpg"));
            reject(()->ExportStore.validateExport(bytes("mime-version: 1.0\nContent-Type: text/plain"),"x.mhtml"));
            reject(()->ExportStore.validateExport(bytes("<!DOCTYPE svg SYSTEM 'https://evil.invalid/a'><svg/>"),"x.svg"));
            // Android's Expat parser lacks the Xerces feature flags: valid HML/SVG must still pass, and the lexical DTD/entity/encoding guards must hold without them.
            javax.xml.parsers.SAXParserFactory expat=new javax.xml.parsers.SAXParserFactory(){
                final javax.xml.parsers.SAXParserFactory real=javax.xml.parsers.SAXParserFactory.newInstance();
                @Override public javax.xml.parsers.SAXParser newSAXParser()throws javax.xml.parsers.ParserConfigurationException,org.xml.sax.SAXException{real.setNamespaceAware(isNamespaceAware());return real.newSAXParser();}
                @Override public void setFeature(String name,boolean value)throws javax.xml.parsers.ParserConfigurationException{throw new javax.xml.parsers.ParserConfigurationException("feature unsupported on this platform: "+name);}
                @Override public boolean getFeature(String name)throws javax.xml.parsers.ParserConfigurationException{throw new javax.xml.parsers.ParserConfigurationException(name);}
            };
            ExportStore.xml(original,"HWPML",expat);checks++;ExportStore.xml(bytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\"/>"),"svg",expat);checks++;
            reject(()->ExportStore.xml(bytes("<!DOCTYPE HWPML [<!ENTITY read SYSTEM 'file:///etc/passwd'>]><HWPML>&read;</HWPML>"),"HWPML",expat));
            reject(()->ExportStore.xml(bytes("<!DOCTYPE svg SYSTEM 'https://evil.invalid/a'><svg/>"),"svg",expat));
            reject(()->ExportStore.xml(bytes("<HWPML><a>"),"HWPML",expat));
            // UTF-16 with and without BOM: valid documents parse, an obfuscated DOCTYPE is still found after strict decoding.
            ExportStore.xml(("\ufeff"+new String(original,StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_16LE),"HWPML",expat);checks++;
            ExportStore.xml(new String(original,StandardCharsets.UTF_8).replace("<?xml version=\"1.0\"?>","").getBytes(StandardCharsets.UTF_16BE),"HWPML",expat);checks++;
            byte[] bomUtf8=new byte[original.length+3];bomUtf8[0]=(byte)0xef;bomUtf8[1]=(byte)0xbb;bomUtf8[2]=(byte)0xbf;System.arraycopy(original,0,bomUtf8,3,original.length);ExportStore.xml(bomUtf8,"HWPML",expat);checks++;
            String entityDocument="<!DOCTYPE HWPML [<!ENTITY read SYSTEM 'file:///etc/passwd'>]><HWPML>&read;</HWPML>";
            reject(()->ExportStore.xml(("\ufeff"+entityDocument).getBytes(StandardCharsets.UTF_16LE),"HWPML",expat));
            reject(()->ExportStore.xml(entityDocument.getBytes(StandardCharsets.UTF_16BE),"HWPML",expat));
            reject(()->ExportStore.xml(new byte[]{'<','H','W','P','M','L','>',(byte)0xc3,(byte)0x28,'<','/','H','W','P','M','L','>'},"HWPML",expat));
            reject(()->ExportStore.xml(bytes("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><HWPML/>"),"HWPML",expat));
            reject(()->ExportStore.xml("<HWPML/>".getBytes(java.nio.charset.Charset.forName("UTF-32BE")),"HWPML",expat));
            reject(()->ExportStore.xml(bytes("<HWPML><!ENTITY x 'y'></HWPML>"),"HWPML",expat));
            for(String suffix:new String[]{"hwp","hwpx"}){byte[] content=Files.readAllBytes(Paths.get(arguments[suffix.equals("hwp")?0:1]));Path document=root.resolve("document."+suffix);files.write(document.toString(),content,null,false);File saved=exports.backup(document.toString(),FileStore.sha(content),"now");yes(Arrays.equals(content,Files.readAllBytes(saved.toPath())));}
            noTemps(root);System.out.println("ExportStore: "+checks+" checks passed");
        }finally{try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.deleteIfExists(path);}catch(IOException ignored){}});}}
    }
}
