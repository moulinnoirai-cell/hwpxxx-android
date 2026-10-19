package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;
import javax.xml.parsers.*;
import org.xml.sax.*;
import org.xml.sax.helpers.DefaultHandler;

/** Local-only file operations. No Android dependency; exercised on the JVM. */
public final class FileStore {
    public static final int MAX_BYTES = 32 * 1024 * 1024;
    public static final long MAX_EXPANDED = 128L * 1024 * 1024;
    private final List<File> roots;
    public FileStore(List<File> roots) throws IOException {
        this.roots = new ArrayList<>();
        for (File f : roots) this.roots.add(f.getCanonicalFile());
    }
    public File resolve(String path) throws IOException {
        File raw = new File(path).getAbsoluteFile();
        File f = raw.getCanonicalFile();
        // Reject any symlink component, including one that points back inside a volume.
        if (!raw.toPath().normalize().equals(f.toPath())) throw new IOException("바로가기 경로는 사용할 수 없어요.");
        for (File root : roots) {
            if (f.toPath().startsWith(root.toPath())) {
                String rel = root.toPath().relativize(f.toPath()).toString().replace('\\','/');
                if (rel.equalsIgnoreCase("Android") || rel.regionMatches(true,0,"Android/",0,8))
                    throw new IOException("Android 보호 폴더에는 접근할 수 없어요.");
                return f;
            }
        }
        throw new IOException("기기 저장공간 안의 경로를 선택해 주세요.");
    }
    public static void name(String name) throws IOException {
        if (name == null || name.trim().isEmpty()) throw new IOException("이름을 입력해 주세요.");
        if (!name.equals(name.trim()) || name.equals(".") || name.equals("..") ||
            java.util.regex.Pattern.compile("[\\\\/\\x00-\\x1f\\x7f]").matcher(name).find() ||
            name.getBytes(StandardCharsets.UTF_8).length > 240)
            throw new IOException("이름의 앞뒤 공백, /, \\ 또는 제어 문자를 지우고 240바이트 이내로 입력해 주세요.");
    }
    public static String ext(File f) {
        String s=f.getName().toLowerCase(Locale.ROOT);
        return s.endsWith(".hwpx") ? "hwpx" : s.endsWith(".hwp") ? "hwp" : s.endsWith(".pdf") ? "pdf" : "";
    }
    public byte[] read(String path) throws IOException {
        File f=resolve(path);
        if (!f.isFile() || f.length() == 0 || f.length() > MAX_BYTES) throw new IOException("빈 파일이거나 32MB를 넘는 문서예요.");
        try (InputStream in=new FileInputStream(f)) { return bounded(in, MAX_BYTES); }
    }
    public static byte[] bounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buf=new byte[16384]; int n;
        while ((n=in.read(buf))!=-1) { if (out.size()+n>limit) throw new IOException("허용한 파일 크기를 넘었어요."); out.write(buf,0,n); }
        return out.toByteArray();
    }
    public static String sha(byte[] b) throws IOException {
        try { byte[] h=MessageDigest.getInstance("SHA-256").digest(b); StringBuilder s=new StringBuilder(); for(byte v:h)s.append(String.format("%02x",v&255));return s.toString(); }
        catch (NoSuchAlgorithmException e) { throw new IOException(e); }
    }
    public static void validate(byte[] bytes, String format) throws IOException {
        if (bytes.length < 8 || bytes.length > MAX_BYTES) throw new IOException("문서의 크기 또는 형식이 올바르지 않아요.");
        if (format.equals("pdf")) {
            if (!new String(bytes,0,5,StandardCharsets.US_ASCII).equals("%PDF-")) throw new IOException("PDF 생성 결과를 확인하지 못했어요.");
            return;
        }
        if (format.equals("hwp")) {
            byte[] magic={(byte)0xd0,(byte)0xcf,0x11,(byte)0xe0,(byte)0xa1,(byte)0xb1,0x1a,(byte)0xe1};
            for(int i=0;i<8;i++)if(bytes[i]!=magic[i])throw new IOException("HWP 5 형식이 아니거나 암호화된 문서예요.");
            if(bytes.length<512)throw new IOException("잘린 HWP 파일이에요.");
            return;
        }
        if (!format.equals("hwpx")) throw new IOException("지원하지 않는 문서 형식이에요.");
        Set<String> seen=new HashSet<>(); Map<String,Long> sizes=new HashMap<>(); long expanded=0; int entries=0; boolean section=false,header=false,mime=false; byte[] manifest=null;
        try (ZipInputStream zin=new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry e;
            while((e=zin.getNextEntry())!=null) {
                if(++entries>2048)throw new IOException("압축 항목이 너무 많아요.");
                String n=e.getName();
                if(n.startsWith("/") || n.contains("\\") || Arrays.asList(n.split("/")).contains("..") || !seen.add(n))throw new IOException("안전하지 않은 압축 경로예요.");
                int limit=xmlLike(n)?8*1024*1024:MAX_BYTES;
                byte[] b=bounded(zin,limit); expanded+=b.length;
                if(expanded>MAX_EXPANDED)throw new IOException("압축을 푼 문서 크기가 너무 커요.");
                sizes.put(n,(long)b.length);
                if(n.equals("mimetype")) mime=new String(b,StandardCharsets.US_ASCII).trim().equals("application/hwp+zip");
                if(n.equals("Contents/header.xml"))header=true;
                if(n.matches("Contents/section[0-9]+\\.xml"))section=true;
                if(n.equals("META-INF/manifest.xml"))manifest=b;
                zin.closeEntry();
            }
        }
        if(!mime || !section || !header)throw new IOException("HWPX 필수 항목이 없어요.");
        centralDirectoryMatches(bytes,sizes);
        // Entries listed as encrypted in the manifest may hold ciphertext instead of XML.
        Set<String> encrypted=manifest==null?Collections.<String>emptySet():encryptedEntries(manifest);
        try (ZipInputStream zin=new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry e;
            while((e=zin.getNextEntry())!=null) {
                String n=e.getName();
                if(xmlLike(n)&&!n.equals("META-INF/manifest.xml")) {
                    byte[] b=bounded(zin,8*1024*1024);
                    if(!(encrypted.contains(n)&&!looksLikeXml(b)))secureXml(b,null);
                }
                zin.closeEntry();
            }
        }
    }
    private static boolean xmlLike(String n){String s=n.toLowerCase(Locale.ROOT);return s.endsWith(".xml")||s.endsWith(".hpf");}
    static boolean looksLikeXml(byte[] b){
        int i=0;
        if(b.length>=3&&b[0]==(byte)0xef&&b[1]==(byte)0xbb&&b[2]==(byte)0xbf)i=3;
        else if(b.length>=2&&((b[0]==(byte)0xff&&b[1]==(byte)0xfe)||(b[0]==(byte)0xfe&&b[1]==(byte)0xff)))return true;
        if(b.length>=2&&((b[0]=='<'&&b[1]==0)||(b[0]==0&&b[1]=='<')))return true;
        while(i<b.length&&(b[i]==' '||b[i]=='\t'||b[i]=='\r'||b[i]=='\n'))i++;
        return i<b.length&&b[i]=='<';
    }
    /** The streaming and central-directory views of the archive must agree, so no reader sees hidden entries. */
    private static void centralDirectoryMatches(byte[] bytes,Map<String,Long> streamed)throws IOException {
        File temp=File.createTempFile("hwpx-check-",".zip");
        try {
            try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);}
            Map<String,Long> central=new HashMap<>();
            try(ZipFile zip=new ZipFile(temp)){
                Enumeration<? extends ZipEntry> all=zip.entries();
                while(all.hasMoreElements()){ZipEntry e=all.nextElement();if(central.put(e.getName(),e.getSize())!=null)throw new IOException("안전하지 않은 압축 경로예요.");}
            }
            if(!central.equals(streamed))throw new IOException("압축 목록이 일치하지 않는 HWPX예요.");
        } catch(ZipException e){throw new IOException("압축 목록이 일치하지 않는 HWPX예요.",e);}
        finally{temp.delete();}
    }
    static Set<String> encryptedEntries(byte[] manifest)throws IOException {Set<String> out=new HashSet<>();secureXml(manifest,out);return out;}
    private static void secureXml(byte[] b,final Set<String> encrypted) throws IOException {
        try {
            // Android's SAX implementation lacks Xerces-only features. Reject DTDs before
            // parsing, decode UTF-8/UTF-16 strictly, and always install a rejecting resolver.
            String encoding="UTF-8";
            if(b.length>3){
                if((b[0]==0&&b[1]==0)||(b[2]==0&&b[3]==0))throw new IOException("UTF-32 XML은 지원하지 않아요.");
                if((b[0]==(byte)0xff&&b[1]==(byte)0xfe)||(b[0]=='<'&&b[1]==0))encoding="UTF-16LE";
                else if((b[0]==(byte)0xfe&&b[1]==(byte)0xff)||(b[0]==0&&b[1]=='<'))encoding="UTF-16BE";
            }
            String decoded=java.nio.charset.Charset.forName(encoding).newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(b)).toString();
            if(decoded.startsWith("\ufeff"))decoded=decoded.substring(1);
            if(decoded.contains("<!DOCTYPE")||decoded.contains("<!ENTITY"))throw new IOException("DTD와 외부 엔티티는 허용하지 않아요.");
            java.util.regex.Matcher declaration=java.util.regex.Pattern.compile("(?i)encoding\\s*=\\s*['\"]([^'\"]+)['\"]").matcher(decoded.substring(0,Math.min(200,decoded.length())));
            if(declaration.find()&&!declaration.group(1).matches("(?i)utf-?8|utf-?16(?:le|be)?"))throw new IOException("지원하지 않는 XML 문자 인코딩이에요.");
            SAXParserFactory f=SAXParserFactory.newInstance(); f.setNamespaceAware(true);
            try{f.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);}catch(ParserConfigurationException|SAXException ignored){}
            try{f.setFeature("http://xml.org/sax/features/external-general-entities",false);}catch(ParserConfigurationException|SAXException ignored){}
            try{f.setFeature("http://xml.org/sax/features/external-parameter-entities",false);}catch(ParserConfigurationException|SAXException ignored){}
            XMLReader r=f.newSAXParser().getXMLReader();
            r.setEntityResolver((publicId,systemId)->{throw new SAXException("외부 참조 차단");});
            r.setErrorHandler(new DefaultHandler(){public void error(SAXParseException e)throws SAXException{throw e;}public void fatalError(SAXParseException e)throws SAXException{throw e;}});
            r.setContentHandler(new DefaultHandler(){
                int depth=0,nodes=0,entryDepth=-1;String entryPath=null;
                public void startElement(String u,String l,String q,Attributes a)throws SAXException{
                    if(++depth>128||++nodes>200000)throw new SAXException("XML 한도 초과");
                    if(encrypted==null)return;
                    String local=l==null||l.isEmpty()?q.substring(q.indexOf(':')+1):l;
                    if(local.equals("file-entry")){
                        entryDepth=depth;entryPath=null;
                        for(int i=0;i<a.getLength();i++){String n=a.getLocalName(i);if(n==null||n.isEmpty())n=a.getQName(i).substring(a.getQName(i).indexOf(':')+1);if(n.equals("full-path"))entryPath=a.getValue(i);}
                    } else if(local.equals("encryption-data")&&entryDepth>0&&entryPath!=null)encrypted.add(entryPath);
                }
                public void endElement(String u,String l,String q){if(depth==entryDepth){entryDepth=-1;entryPath=null;}depth--;}
            });
            // Parse the already decoded characters so an alternate encoding declaration
            // cannot reinterpret the bytes used for the DTD check.
            r.parse(new InputSource(new StringReader(decoded)));
        } catch(Exception e){throw new IOException("HWPX XML을 안전하게 읽을 수 없어요. 외부 참조 또는 문서 구조를 확인해 주세요.",e);}
    }
    public File createFolder(String parent,String child)throws IOException {
        name(child);File dir=resolve(parent),f=resolve(new File(dir,child).getPath());
        if(!dir.isDirectory())throw new IOException("폴더를 찾을 수 없어요.");
        if(f.exists())throw new IOException("같은 이름의 항목이 있어요.");
        if(!f.mkdir())throw new IOException("폴더를 만들 수 없어요. 접근 권한과 남은 공간을 확인해 주세요.");return f;
    }
    public File write(String target,byte[] bytes,String expectedSha,boolean replace)throws IOException {
        File dest=resolve(target);name(dest.getName());validate(bytes,ext(dest));
        File parent=dest.getParentFile();if(!parent.isDirectory()||!parent.canWrite())throw new IOException("저장할 폴더에 쓸 수 없어요.");
        if(parent.getUsableSpace()<bytes.length+1024*1024L)throw new IOException("저장공간이 부족해요.");
        File temp=File.createTempFile(".hwp-offline-",".tmp",parent);
        try {
            try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}
            byte[] check;try(InputStream in=new FileInputStream(temp)){check=bounded(in,MAX_BYTES);}
            if(!sha(bytes).equals(sha(check)))throw new IOException("저장 결과가 일치하지 않아요.");
            if(replace) {
                if(!dest.isFile()||expectedSha==null||!sha(read(dest.getPath())).equals(expectedSha))throw new IOException("다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.");
                // No delete-before-write and no unsafe fallback when atomic replacement is unavailable.
                try { Files.move(temp.toPath(),dest.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
                catch(AtomicMoveNotSupportedException e){throw new IOException("이 저장공간은 안전한 덮어쓰기를 지원하지 않아요. 다른 이름으로 저장해 주세요.",e);}
            } else {
                // CREATE_NEW reserves the final name. A collision never overwrites existing bytes.
                boolean made=false;
                try {
                    if(!dest.createNewFile())throw new IOException("같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.");made=true;
                    try { Files.move(temp.toPath(),dest.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
                    catch(AtomicMoveNotSupportedException unsupported) {
                        try(InputStream in=new FileInputStream(temp);FileOutputStream out=new FileOutputStream(dest)){byte[] buf=new byte[16384];int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);out.getFD().sync();}
                    }
                    if(!sha(bytes).equals(sha(read(dest.getPath()))))throw new IOException("저장 결과가 일치하지 않아요.");
                } catch(IOException e){if(made)dest.delete();throw e;}
            }
            return dest;
        } finally {temp.delete();}
    }
    /** Copies the current HWP next to itself before its first in-place save; HWPX returns null. */
    public File backup(String target,String expectedSha,String stamp)throws IOException {
        File f=resolve(target);if(!ext(f).equals("hwp"))return null;
        byte[] bytes=read(f.getPath());
        if(expectedSha==null||!sha(bytes).equals(expectedSha))throw new IOException("다른 앱에서 문서가 바뀌었어요. 다른 이름으로 저장해 주세요.");
        File dir=f.getParentFile();String base=f.getName().substring(0,f.getName().length()-4),suffix="_백업_"+stamp;
        while(!base.isEmpty()&&(base+suffix+"-99.hwp").getBytes(StandardCharsets.UTF_8).length>240)base=base.substring(0,base.offsetByCodePoints(base.length(),-1));
        File dest=new File(dir,base+suffix+".hwp");
        for(int i=2;dest.exists();i++){if(i>99)throw new IOException("백업 파일 이름을 정하지 못했어요.");dest=new File(dir,base+suffix+"-"+i+".hwp");}
        return write(dest.getPath(),bytes,null,false);
    }
    public File move(String source,String parent,String newName)throws IOException {
        File src=resolve(source),dir=resolve(parent);name(newName);
        File dest=resolve(new File(dir,newName).getPath());
        if(src.equals(dest))throw new IOException("현재 폴더와 같은 위치예요.");
        byte[] bytes=read(source);String hash=sha(bytes);validate(bytes,ext(src));
        if(dest.exists())throw new IOException("같은 이름의 파일이 있어요. 다른 폴더를 선택해 주세요.");
        write(dest.getPath(),bytes,null,false);
        // Delete source only after complete write, fsync, checksum, and a second source comparison.
        if(!sha(read(source)).equals(hash)) {dest.delete();throw new IOException("이동 중 원본이 바뀌어 이동을 중지했어요.");}
        if(!src.delete())throw new IOException("새 위치에 복사했지만 원본을 지우지 못했어요. 두 파일이 보존되어 있어요.");
        return dest;
    }
}
