package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.xml.parsers.*;
import org.xml.sax.*;
import org.xml.sax.helpers.DefaultHandler;

/** Additional desktop formats, using FileStore's bounded paths and durable-write rules. */
final class ExportStore {
    interface Mover {void move(Path source,Path destination)throws IOException;}
    private final FileStore files;
    private final Mover mover;
    ExportStore(FileStore files){this(files,(source,destination)->Files.move(source,destination,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING));}
    ExportStore(FileStore files,Mover mover){this.files=files;this.mover=mover;}
    static String extension(String name){int dot=name.lastIndexOf('.');return dot<0?"":name.substring(dot+1).toLowerCase(Locale.ROOT);}
    static String documentFormat(File file){return extension(file.getName()).equals("hml")?"hml":FileStore.ext(file);}
    static void validateDocument(byte[] bytes,String format)throws IOException {
        if(!format.equals("hml")){FileStore.validate(bytes,format);return;}
        xml(bytes,"HWPML");
    }
    static void validateExport(byte[] bytes,String name)throws IOException {
        bounded(bytes);String format=extension(name);
        switch(format){
            case "hml":xml(bytes,"HWPML");return;
            case "svg":xml(bytes,"svg");return;
            case "html":case "htm":case "doc":{
                String start=new String(bytes,0,Math.min(bytes.length,2048),StandardCharsets.UTF_8).replace("\ufeff","").trim().toLowerCase(Locale.ROOT);
                if(!start.startsWith("<!doctype html")&&!start.startsWith("<html"))throw new IOException("HTML 내보내기 형식이 일치하지 않아요.");return;
            }
            case "mhtml":case "mht":{
                String start=new String(bytes,0,Math.min(bytes.length,8192),StandardCharsets.US_ASCII).toLowerCase(Locale.ROOT);
                if(!start.contains("mime-version:")||!start.contains("content-type: multipart/"))throw new IOException("MHTML 내보내기 형식이 일치하지 않아요.");return;
            }
            case "png":if(bytes.length<8||bytes[0]!=(byte)137||bytes[1]!=80||bytes[2]!=78||bytes[3]!=71||bytes[4]!=13||bytes[5]!=10||bytes[6]!=26||bytes[7]!=10)throw new IOException("PNG 형식이 일치하지 않아요.");return;
            case "jpg":case "jpeg":if(bytes.length<4||bytes[0]!=(byte)255||bytes[1]!=(byte)216||bytes[bytes.length-2]!=(byte)255||bytes[bytes.length-1]!=(byte)217)throw new IOException("JPEG 형식이 일치하지 않아요.");return;
            case "txt":for(byte b:bytes)if(b==0)throw new IOException("텍스트 파일에 이진 자료가 있어요.");return;
            default:throw new IOException("지원하지 않는 내보내기 형식이에요.");
        }
    }
    private static void bounded(byte[] bytes)throws IOException {if(bytes==null||bytes.length<1||bytes.length>FileStore.MAX_BYTES)throw new IOException("내보내기 크기가 올바르지 않아요.");}
    private static void xml(byte[] bytes,String expectedRoot)throws IOException {xml(bytes,expectedRoot,null);}
    /**
     * Android's SAX implementation (Expat) lacks Xerces-only features, so a mandatory setFeature would reject every valid file there.
     * Same approach as FileStore.secureXml: decode characters strictly and reject DTD/ENTITY lexically BEFORE parsing, always install a
     * rejecting resolver, and treat the parser feature flags as optional extra hardening. The factory is injectable so tests can
     * simulate a platform without those features.
     */
    static void xml(byte[] bytes,String expectedRoot,SAXParserFactory supplied)throws IOException {
        bounded(bytes);
        try {
            String decoded=decodeXml(bytes);
            SAXParserFactory factory=supplied!=null?supplied:SAXParserFactory.newInstance();factory.setNamespaceAware(true);
            try{factory.setXIncludeAware(false);}catch(UnsupportedOperationException ignored){}
            optional(factory,"http://apache.org/xml/features/disallow-doctype-decl",true);
            optional(factory,"http://xml.org/sax/features/external-general-entities",false);
            optional(factory,"http://xml.org/sax/features/external-parameter-entities",false);
            XMLReader reader=factory.newSAXParser().getXMLReader();
            final boolean[] seen={false};
            DefaultHandler handler=new DefaultHandler(){int depth,elements;
                @Override public void startElement(String uri,String local,String qName,Attributes attrs)throws SAXException {
                    if(++depth>128||++elements>500000||attrs.getLength()>256)throw new SAXException("XML 문서가 너무 복잡해요.");
                    if(!seen[0]){if(!expectedRoot.equalsIgnoreCase(local.isEmpty()?qName:local))throw new SAXException("문서의 XML 형식이 일치하지 않아요.");seen[0]=true;}
                }
                @Override public void endElement(String uri,String local,String qName){depth--;}
                @Override public InputSource resolveEntity(String publicId,String systemId)throws SAXException {throw new SAXException("외부 XML 참조는 사용할 수 없어요.");}
                @Override public void error(SAXParseException error)throws SAXException {throw error;}
                @Override public void fatalError(SAXParseException error)throws SAXException {throw error;}
            };
            reader.setEntityResolver(handler);reader.setErrorHandler(handler);reader.setContentHandler(handler);
            // Parse the already decoded characters so an alternate encoding declaration cannot reinterpret the bytes the DTD check saw.
            reader.parse(new InputSource(new StringReader(decoded)));
            if(!seen[0])throw new IOException("빈 XML 문서예요.");
        }catch(IOException error){throw error;}
        catch(ParserConfigurationException|SAXException|RuntimeException error){throw new IOException("XML 문서를 안전하게 확인하지 못했어요.",error);}
    }
    private static void optional(SAXParserFactory factory,String feature,boolean value){
        try{factory.setFeature(feature,value);}catch(ParserConfigurationException|SAXException|RuntimeException ignored){}
    }
    private static String decodeXml(byte[] b)throws IOException {
        String encoding="UTF-8";
        if(b.length>3){
            if((b[0]==0&&b[1]==0)||(b[2]==0&&b[3]==0))throw new IOException("UTF-32 XML은 지원하지 않아요.");
            if((b[0]==(byte)0xff&&b[1]==(byte)0xfe)||(b[0]=='<'&&b[1]==0))encoding="UTF-16LE";
            else if((b[0]==(byte)0xfe&&b[1]==(byte)0xff)||(b[0]==0&&b[1]=='<'))encoding="UTF-16BE";
        }
        String decoded;
        try{decoded=java.nio.charset.Charset.forName(encoding).newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(b)).toString();}
        catch(java.nio.charset.CharacterCodingException error){throw new IOException("XML 문자 인코딩이 올바르지 않아요.",error);}
        if(decoded.startsWith("\ufeff"))decoded=decoded.substring(1);
        if(decoded.contains("<!DOCTYPE")||decoded.contains("<!ENTITY"))throw new IOException("DTD와 외부 엔티티는 허용하지 않아요.");
        java.util.regex.Matcher declaration=java.util.regex.Pattern.compile("(?i)encoding\\s*=\\s*['\"]([^'\"]+)['\"]").matcher(decoded.substring(0,Math.min(200,decoded.length())));
        if(declaration.find()&&!declaration.group(1).matches("(?i)utf-?8|utf-?16(?:le|be)?"))throw new IOException("지원하지 않는 XML 문자 인코딩이에요.");
        return decoded;
    }
    File write(String target,byte[] bytes,String expectedSha,boolean replace)throws IOException {
        File destination=files.resolve(target);FileStore.name(destination.getName());validateExport(bytes,destination.getName());
        File parent=destination.getParentFile();if(!parent.isDirectory()||!parent.canWrite())throw new IOException("저장할 폴더에 쓸 수 없어요.");
        if(parent.getUsableSpace()<bytes.length+1024*1024L)throw new IOException("저장공간이 부족해요.");
        // Only HML documents can replace a baseline. General exports always create new copies.
        if(replace&&!extension(destination.getName()).equals("hml"))throw new IOException("내보내기는 새 파일로 저장해 주세요.");
        if(replace&&(!destination.isFile()||!destination.canWrite()))throw new IOException("원본을 안전하게 바꿀 수 없어요. 다른 이름으로 저장해 주세요.");
        FileStore.removeStaleTemps(parent);File temporary=File.createTempFile(".hwp-offline-",".tmp",parent);
        try {
            try(FileOutputStream output=new FileOutputStream(temporary)){output.write(bytes);output.getFD().sync();}
            if(!FileStore.sha(bytes).equals(FileStore.sha(files.read(temporary.getPath()))))throw new IOException("저장 결과가 일치하지 않아요.");
            if(replace){
                if(expectedSha==null||!FileStore.sha(files.read(target)).equals(expectedSha))throw new IOException("다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.");
                try{mover.move(temporary.toPath(),destination.toPath());}catch(AtomicMoveNotSupportedException unsupported){throw new IOException("이 저장공간은 안전한 덮어쓰기를 지원하지 않아요. 다른 이름으로 저장해 주세요.",unsupported);}
            }else{
                boolean made=false;
                try{
                    if(!destination.createNewFile())throw new IOException("같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.");made=true;
                    try{mover.move(temporary.toPath(),destination.toPath());}catch(AtomicMoveNotSupportedException unsupported){try(InputStream input=new FileInputStream(temporary);FileOutputStream output=new FileOutputStream(destination)){byte[] buffer=new byte[16384];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);output.getFD().sync();}}
                    if(!FileStore.sha(bytes).equals(FileStore.sha(files.read(target))))throw new IOException("저장 결과가 일치하지 않아요.");
                }catch(IOException error){if(made)destination.delete();throw error;}
            }
            return destination;
        }finally{temporary.delete();}
    }
    /** Studio originals of every supported format retain a hash-checked, durable backup. */
    File backup(String target,String expectedSha,String stamp)throws IOException {
        File original=files.resolve(target);String format=documentFormat(original);if(!format.matches("hwp|hwpx|hml"))throw new IOException("백업할 문서 형식을 알 수 없어요.");
        byte[] bytes=files.read(target);if(expectedSha==null||!FileStore.sha(bytes).equals(expectedSha))throw new IOException("다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.");validateDocument(bytes,format);
        String base=original.getName().substring(0,original.getName().length()-format.length()-1),suffix="_백업_"+stamp;
        while(!base.isEmpty()&&(base+suffix+"-99."+format).getBytes(StandardCharsets.UTF_8).length>240)base=base.substring(0,base.offsetByCodePoints(base.length(),-1));
        File destination=new File(original.getParentFile(),base+suffix+"."+format);
        for(int index=2;destination.exists();index++){if(index>99)throw new IOException("백업 파일 이름을 정하지 못했어요.");destination=new File(original.getParentFile(),base+suffix+"-"+index+"."+format);}
        if(format.equals("hml"))return write(destination.getPath(),bytes,null,false);
        return files.write(destination.getPath(),bytes,null,false);
    }
}
