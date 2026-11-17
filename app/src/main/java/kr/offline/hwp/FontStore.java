package kr.offline.hwp;

import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.security.*;
import java.text.Normalizer;
import java.util.*;

/** Private, content-addressed user font copies. No Android dependency or source URI persistence. */
public final class FontStore {
    public static final int MAX_FONT_BYTES = 16 * 1024 * 1024;
    public static final int MAX_FONTS = 64;
    public static final long MAX_TOTAL_BYTES = 256L * 1024 * 1024;
    /** A picked file may be a TrueType collection (.ttc) holding several faces; each extracted face still obeys MAX_FONT_BYTES. */
    public static final int MAX_SOURCE_BYTES = 48 * 1024 * 1024;
    public static final int MAX_COLLECTION_FACES = 16;
    private final File root;

    public FontStore(File directory) throws IOException {
        File absolute = directory.getAbsoluteFile();
        if (!absolute.toPath().normalize().equals(absolute.getCanonicalFile().toPath()))
            throw new IOException("글꼴 저장 폴더에 바로가기를 사용할 수 없어요.");
        if (!absolute.isDirectory() && !absolute.mkdirs()) throw new IOException("글꼴 저장 폴더를 만들지 못했어요.");
        root = absolute.getCanonicalFile();
    }

    public static final class Face {
        public final String id, family, fullName, postscriptName, style, slant;
        public final int weight;
        public final List<String> aliases;
        private Face(String id, String family, String fullName, String postscriptName,
                     String style, String slant, int weight, List<String> aliases) {
            this.id=id; this.family=family; this.fullName=fullName; this.postscriptName=postscriptName;
            this.style=style; this.slant=slant; this.weight=weight;
            this.aliases=Collections.unmodifiableList(new ArrayList<>(aliases));
        }
        public Map<String,Object> toMap() {
            Map<String,Object> m=new LinkedHashMap<>();
            m.put("id",id); m.put("family",family); m.put("fullName",fullName);
            m.put("postscriptName",postscriptName); m.put("style",style);
            m.put("slant",slant); m.put("weight",weight); m.put("aliases",aliases);
            return m;
        }
    }

    /** Caller owns and closes the SAF stream. An interrupted/invalid import never replaces a font. */
    public synchronized Face importFont(InputStream source) throws IOException {return importFonts(source).get(0);}

    /**
     * Imports every face of the picked file: one for a plain TTF/OTF, one per member for a TrueType collection (.ttc, e.g. the Windows
     * 바탕/굴림/돋움 files). Collection members and fonts whose tables are not 4-byte aligned (some 1990s Korean fonts; browsers refuse them)
     * are rewritten as standalone, aligned SFNT files with fresh checksums; glyph data is copied byte for byte. Every face is validated before
     * anything is stored, and a file whose new faces do not all fit in the store limits is refused as a whole (nothing is stored).
     */
    public synchronized List<Face> importFonts(InputStream source) throws IOException {
        if(source==null) throw new IOException("글꼴 파일을 읽을 수 없어요.");
        byte[] file=boundedRead(source,MAX_SOURCE_BYTES);
        List<byte[]> members=members(file); List<Face> checked=new ArrayList<>();
        for(byte[] member:members) checked.add(validate(member,sha(member)));
        List<File> files=fontFiles(); long size=0; int added=0;
        for(File f:files) size+=f.length();
        for(int i=0;i<members.size();i++) if(!file(checked.get(i).id).exists()) {added++; size+=members.get(i).length;}
        if(files.size()+added>MAX_FONTS || size>MAX_TOTAL_BYTES) throw new IOException(LIMIT);
        List<Face> stored=new ArrayList<>();
        for(int i=0;i<members.size();i++) stored.add(store(members.get(i),checked.get(i)));
        return Collections.unmodifiableList(stored);
    }

    private Face store(byte[] bytes,Face face) throws IOException {
        String id=face.id;
        File target=file(id);
        if(target.exists()) {
            if(!Arrays.equals(readFile(target),bytes)) throw new IOException("저장된 글꼴이 손상되었어요. 삭제 후 다시 추가해 주세요.");
            return face;
        }
        List<File> files=fontFiles(); long size=0;
        for(File f:files) size+=f.length();
        if(files.size()>=MAX_FONTS || size+bytes.length>MAX_TOTAL_BYTES)
            throw new IOException(LIMIT);
        Path temporary=Files.createTempFile(root.toPath(),".font-",".tmp");
        try {
            File temp=temporary.toFile();
            temp.setReadable(false,false); temp.setWritable(false,false);
            temp.setReadable(true,true); temp.setWritable(true,true);
            try(FileOutputStream output=new FileOutputStream(temp)) {output.write(bytes); output.getFD().sync();}
            // Same private directory: an incomplete copy is never visible to the catalog.
            Files.move(temporary,target.toPath(),StandardCopyOption.ATOMIC_MOVE);
        } finally {Files.deleteIfExists(temporary);}
        return face;
    }

    /** Each list rechecks integrity. Corrupt entries are omitted, never silently overwritten. */
    public synchronized List<Face> list() throws IOException {
        List<Face> faces=new ArrayList<>();
        for(File f:fontFiles()) {
            String id=f.getName().substring(0,64);
            try {byte[] bytes=readFile(f); if(!sha(bytes).equals(id)) continue; faces.add(validate(bytes,id));}
            catch(IOException invalid) { /* A broken private copy must not reach the renderer. */ }
        }
        return Collections.unmodifiableList(faces);
    }

    public synchronized Map<String,Object> snapshot() throws IOException {
        List<Face> faces=list(); List<Map<String,Object>> records=new ArrayList<>();
        for(Face face:faces) records.add(face.toMap());
        Map<String,Object> snapshot=new LinkedHashMap<>();
        snapshot.put("revision",revision(faces)); snapshot.put("faces",records);
        return snapshot;
    }

    public synchronized byte[] read(String id,String expectedRevision) throws IOException {
        File f=file(id);
        List<Face> faces=list();
        if(expectedRevision==null || !revision(faces).equals(expectedRevision))
            throw new IOException("글꼴 목록이 바뀌었어요. 다시 불러와 주세요.");
        boolean found=false; for(Face face:faces) if(face.id.equals(id)) found=true;
        if(!found) throw new IOException("글꼴을 찾을 수 없어요.");
        byte[] bytes=readFile(f);
        if(!sha(bytes).equals(id)) throw new IOException("저장된 글꼴이 손상되었어요.");
        validate(bytes,id);
        return bytes;
    }

    public synchronized boolean delete(String id) throws IOException { return Files.deleteIfExists(file(id).toPath()); }

    private File file(String id) throws IOException {
        if(id==null || !id.matches("[0-9a-f]{64}")) throw new IOException("잘못된 글꼴 ID예요.");
        File file=new File(root,id+".sfnt");
        if(Files.isSymbolicLink(file.toPath()) || !file.getCanonicalFile().getParentFile().equals(root))
            throw new IOException("잘못된 글꼴 저장 경로예요.");
        return file;
    }

    private List<File> fontFiles() throws IOException {
        File[] entries=root.listFiles();
        if(entries==null) throw new IOException("글꼴 목록을 읽지 못했어요.");
        List<File> files=new ArrayList<>();
        for(File entry:entries) {
            if(!entry.getName().matches("[0-9a-f]{64}\\.sfnt")) continue;
            // Reject links even when they point back inside the private store.
            if(Files.isSymbolicLink(entry.toPath()) || !entry.isFile()) continue;
            files.add(file(entry.getName().substring(0,64)));
        }
        files.sort(Comparator.comparing(File::getName));
        if(files.size()>MAX_FONTS) throw new IOException("글꼴 저장 한도를 초과했어요.");
        return files;
    }

    private static byte[] readFile(File f) throws IOException {
        if(f.length()<12 || f.length()>MAX_FONT_BYTES) throw bad();
        try(InputStream input=new FileInputStream(f)) {return boundedRead(input,MAX_FONT_BYTES);}
    }

    private static byte[] boundedRead(InputStream source,int limit) throws IOException {
        ByteArrayOutputStream output=new ByteArrayOutputStream(); byte[] chunk=new byte[16384]; int count;
        while((count=source.read(chunk))!=-1) {
            if(count==0) {int one=source.read(); if(one==-1) break; if(output.size()==limit) throw tooLarge(); output.write(one); continue;}
            if(count>limit-output.size()) throw tooLarge();
            output.write(chunk,0,count);
        }
        return output.toByteArray();
    }

    /** The standalone SFNT files held by a picked file: the file itself, its aligned rewrite, or one rewrite per collection member. */
    private static List<byte[]> members(byte[] file) throws IOException {
        range(file,0,12); long signature=u32(file,0);
        if(signature==0x774f4646L || signature==0x774f4632L) throw new IOException("WOFF 글꼴은 지원하지 않아요. TTF·OTF·TTC 파일을 가져와 주세요.");
        List<byte[]> out=new ArrayList<>();
        if(signature==0x74746366L) {
            long version=u32(file,4),count=u32(file,8);
            if((version!=0x00010000L && version!=0x00020000L) || count<1) throw bad();
            if(count>MAX_COLLECTION_FACES) throw new IOException("글꼴 묶음(TTC) 하나에 글꼴이 너무 많아요. 16개까지 가져올 수 있어요.");
            range(file,12,4*count); Set<Long> seen=new HashSet<>();
            for(int i=0;i<count;i++) {long offset=u32(file,12+4*i); if(seen.add(offset)) out.add(repack(file,offset));}
            return out;
        }
        if(signature!=0x00010000L && signature!=0x4f54544fL) throw bad();
        if(file.length>MAX_FONT_BYTES) throw tooLarge();
        int count=u16(file,4); boolean aligned=true;
        if(12L+16L*count<=file.length) for(int i=0;i<count;i++) if((u32(file,12+16*i+8)&3)!=0) aligned=false;
        out.add(aligned?file:repack(file,0));
        return out;
    }

    private static long checksum(byte[] b,int start,int length) {
        long sum=0; int end=start+length,p=start;
        for(;p+4<=end;p+=4) sum+=u32(b,p);
        if(p<end) {long last=0; for(int i=0;i<4;i++) last=(last<<8)|(p+i<end?(b[p+i]&255):0); sum+=last;}
        return sum&0xffffffffL;
    }
    private static void put32(byte[] b,int p,long value) {b[p]=(byte)(value>>>24);b[p+1]=(byte)(value>>>16);b[p+2]=(byte)(value>>>8);b[p+3]=(byte)value;}

    /**
     * Rewrites the font whose table directory starts at {@code directory} (inside a collection, or a font with unaligned tables) as a
     * standalone SFNT: tables sorted by tag, 4-byte aligned, table checksums and head.checkSumAdjustment recomputed. Table contents are
     * copied unchanged; a DSIG table is dropped because its signature no longer covers the new file.
     */
    private static byte[] repack(byte[] file,long directory) throws IOException {
        range(file,directory,12); int at=(int)directory; long signature=u32(file,at);
        if(signature!=0x00010000L && signature!=0x4f54544fL) throw bad();
        int count=u16(file,at+4); if(count<5 || count>256) throw bad();
        range(file,directory+12,16L*count);
        TreeMap<String,int[]> tables=new TreeMap<>(); long total=12;
        for(int i=0;i<count;i++) {
            int p=at+12+16*i; String tag=new String(file,p,4,StandardCharsets.ISO_8859_1);
            if(!tag.matches("[ -~]{4}")) throw bad();
            long offset=u32(file,p+8),length=u32(file,p+12); range(file,offset,length);
            if(tag.equals("DSIG")) continue;
            if(tables.put(tag,new int[]{(int)offset,(int)length})!=null) throw bad();
            total+=16+((length+3)&~3L);
        }
        if(total>MAX_FONT_BYTES) throw tooLarge();
        byte[] out=new byte[(int)total]; int n=tables.size(),power=Integer.highestOneBit(n);
        put32(out,0,signature); out[4]=(byte)(n>>>8); out[5]=(byte)n;
        out[6]=(byte)((power*16)>>>8); out[7]=(byte)(power*16);
        out[8]=0; out[9]=(byte)Integer.numberOfTrailingZeros(power);
        out[10]=(byte)((n*16-power*16)>>>8); out[11]=(byte)(n*16-power*16);
        int record=12,data=12+16*n,head=-1;
        for(Map.Entry<String,int[]> entry:tables.entrySet()) {
            int offset=entry.getValue()[0],length=entry.getValue()[1];
            System.arraycopy(file,offset,out,data,length);
            if(entry.getKey().equals("head")) {if(length<12) throw bad(); head=data; put32(out,head+8,0);}
            System.arraycopy(entry.getKey().getBytes(StandardCharsets.ISO_8859_1),0,out,record,4);
            put32(out,record+4,checksum(out,data,length)); put32(out,record+8,data); put32(out,record+12,length);
            record+=16; data+=(length+3)&~3;
        }
        if(head<0) throw bad();
        put32(out,head+8,(0xB1B0AFBAL-checksum(out,0,out.length))&0xffffffffL);
        return out;
    }

    private static String revision(List<Face> faces) {
        StringBuilder key=new StringBuilder("android-fonts-v2\n");
        for(Face face:faces) key.append(face.id).append('\n');
        return sha(key.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String sha(byte[] bytes) {
        try {byte[] hash=MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder text=new StringBuilder(64);
            for(byte b:hash) text.append(String.format(Locale.ROOT,"%02x",b&255)); return text.toString();}
        catch(NoSuchAlgorithmException impossible) {throw new AssertionError(impossible);}
    }

    private static IOException bad() {return new IOException("올바른 TTF/OTF/TTC 글꼴 파일이 아니에요. 한컴 전용 HFT 글꼴과 WOFF 글꼴은 지원하지 않아요.");}
    private static final String LIMIT="저장 글꼴 한도(64개 또는 256MB)에 도달했어요. 사용하지 않는 글꼴을 삭제해 주세요.";
    private static IOException tooLarge() {return new IOException("글꼴은 하나당 16MB까지(글꼴 묶음 TTC 파일은 48MB까지) 추가할 수 있어요.");}

    private static final class Table {
        final int offset,length;
        Table(int offset,int length) {this.offset=offset;this.length=length;}
    }
    private static int u16(byte[] b,int p) {return ((b[p]&255)<<8)|(b[p+1]&255);}
    private static long u32(byte[] b,int p) {return ((long)u16(b,p)<<16)|u16(b,p+2);}
    private static void range(byte[] b,long start,long length) throws IOException {
        if(start<0 || length<0 || start>b.length || length>b.length-start) throw bad();
    }
    private static Table need(Map<String,Table> tables,String tag,int minimum) throws IOException {
        Table table=tables.get(tag); if(table==null || table.length<minimum) throw bad(); return table;
    }

    /** Bounded SFNT structural validation; rendering additionally uses browser/CanvasKit font decoders. */
    private static Face validate(byte[] bytes,String id) throws IOException {
        range(bytes,0,12); if(bytes.length>MAX_FONT_BYTES) throw tooLarge();
        long signature=u32(bytes,0); boolean cff=signature==0x4f54544fL;
        if(signature!=0x00010000L && !cff) throw bad();
        int count=u16(bytes,4); if(count<5 || count>256) throw bad();
        int directoryEnd=12+count*16; range(bytes,12,count*16);
        Map<String,Table> tables=new HashMap<>(); List<Table> occupied=new ArrayList<>();
        for(int i=0;i<count;i++) {
            int p=12+i*16; String tag=new String(bytes,p,4,StandardCharsets.ISO_8859_1);
            if(!tag.matches("[ -~]{4}")) throw bad();
            long offset=u32(bytes,p+8),length=u32(bytes,p+12); range(bytes,offset,length);
            if(offset<directoryEnd || (offset&3)!=0 || tables.containsKey(tag)) throw bad();
            Table table=new Table((int)offset,(int)length); tables.put(tag,table);
            if(length>0) occupied.add(table);
        }
        occupied.sort(Comparator.comparingInt(table->table.offset));
        for(int i=1;i<occupied.size();i++)
            if((long)occupied.get(i-1).offset+occupied.get(i-1).length>occupied.get(i).offset) throw bad();
        Table head=need(tables,"head",54), maxp=need(tables,"maxp",6), cmap=need(tables,"cmap",4);
        Table hhea=need(tables,"hhea",36), hmtx=need(tables,"hmtx",4), name=need(tables,"name",6);
        if(u32(bytes,head.offset)!=0x00010000L || u32(bytes,head.offset+12)!=0x5f0f3cf5L) throw bad();
        int units=u16(bytes,head.offset+18),glyphs=u16(bytes,maxp.offset+4),metrics=u16(bytes,hhea.offset+34);
        if(units<16 || units>16384 || glyphs==0 || metrics==0 || metrics>glyphs
            || hmtx.length<4*metrics+2*(glyphs-metrics)) throw bad();
        if(cff) {
            Table compact=tables.get("CFF "),compact2=tables.get("CFF2");
            if(compact==null && compact2==null) throw bad();
            if(compact!=null && (compact.length<4 || bytes[compact.offset]!=1
                || (bytes[compact.offset+2]&255)<4 || (bytes[compact.offset+2]&255)>compact.length
                || (bytes[compact.offset+3]&255)<1 || (bytes[compact.offset+3]&255)>4)) throw bad();
            if(compact2!=null && (compact2.length<5 || bytes[compact2.offset]!=2
                || (bytes[compact2.offset+2]&255)<5
                || (long)(bytes[compact2.offset+2]&255)+u16(bytes,compact2.offset+3)>compact2.length)) throw bad();
        }
        else {
            if(u32(bytes,maxp.offset)!=0x00010000L || maxp.length<32) throw bad();
            Table glyf=need(tables,"glyf",1),loca=need(tables,"loca",2);
            int format=u16(bytes,head.offset+50); if(format>1 || loca.length<(glyphs+1)*(format==0?2:4)) throw bad();
            long previous=0;
            for(int i=0;i<=glyphs;i++) {long offset=format==0?2L*u16(bytes,loca.offset+2*i):u32(bytes,loca.offset+4*i);
                if(offset<previous || offset>glyf.length) throw bad(); previous=offset;}
        }
        if(u16(bytes,cmap.offset)!=0) throw bad();
        int encodings=u16(bytes,cmap.offset+2); if(encodings==0 || 4L+8L*encodings>cmap.length) throw bad();
        for(int i=0;i<encodings;i++) {long relative=u32(bytes,cmap.offset+4+8*i+4);
            if(relative<4+8L*encodings || relative>cmap.length-2) throw bad();
            int at=cmap.offset+(int)relative,format=u16(bytes,at); long length;
            if(format==8 || format==10 || format==12 || format==13) {if(relative>cmap.length-8) throw bad(); length=u32(bytes,at+4);}
            else if(format==14) {if(relative>cmap.length-6) throw bad(); length=u32(bytes,at+2);}
            else {if(relative>cmap.length-4) throw bad(); length=u16(bytes,at+2);}
            if(length<4 || length>cmap.length-relative) throw bad();
        }
        Map<Integer,List<String>> names=names(bytes,name);
        String family=first(names,16,1),style=first(names,17,2),full=first(names,4),postscript=first(names,6);
        if(family.isEmpty()) throw bad();
        if(style.isEmpty()) style="Regular"; if(full.isEmpty()) full=family+" "+style;
        int weight=400; boolean italic=(u16(bytes,head.offset+44)&2)!=0,oblique=false;
        Table os2=tables.get("OS/2");
        if(os2!=null && os2.length>=8) {weight=u16(bytes,os2.offset+4); if(weight<1 || weight>1000) throw bad();
            if(os2.length>=64) {int selection=u16(bytes,os2.offset+62); italic|=(selection&1)!=0; oblique=(selection&512)!=0;}}
        List<String> aliases=new ArrayList<>();
        for(int nameId:new int[]{16,1,4,6,17,2}) for(String value:names.getOrDefault(nameId,Collections.emptyList()))
            if(!aliases.contains(value) && aliases.size()<32) aliases.add(value);
        return new Face(id,family,full,postscript,style,italic?"italic":oblique?"oblique":"normal",weight,aliases);
    }

    private static String first(Map<Integer,List<String>> names,int... ids) {
        for(int id:ids) {List<String> values=names.get(id); if(values!=null && !values.isEmpty()) return values.get(0);} return "";
    }

    private static Charset charset(String... candidates) {
        for(String name:candidates) try {if(Charset.isSupported(name)) return Charset.forName(name);} catch(IllegalArgumentException unknown) { /* next */ }
        return null;
    }
    private static String strict(Charset charset,byte[] bytes,int start,int length) {
        if(charset==null) return null;
        try {return charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes,start,length)).toString();}
        catch(CharacterCodingException malformed) {return null;}
    }
    /** A name record in a pre-Unicode encoding, or null when it cannot be decoded with confidence. */
    private static String legacyName(byte[] bytes,int start,int length,int platform,int encoding) {
        Charset charset;
        if(platform==3) {
            if(encoding==5) charset=charset("x-windows-949","windows-949","MS949","EUC-KR");
            else if(encoding==6) charset=charset("x-Johab","Johab");
            else return null;
            // Windows legacy records store each character in two bytes; single-byte characters have a zero high byte.
            byte[] packed=new byte[length]; int size=0;
            if((length&1)==0) for(int i=0;i<length;i+=2) {if(bytes[start+i]!=0) packed[size++]=bytes[start+i]; packed[size++]=bytes[start+i+1];}
            else {System.arraycopy(bytes,start,packed,0,length); size=length;}
            String text=strict(charset,packed,0,size);
            // Some fonts label UTF-16 names as Wansung.
            if(text==null && (length&1)==0) text=strict(StandardCharsets.UTF_16BE,bytes,start,length);
            return text;
        }
        if(platform==1) {
            if(encoding==3) return strict(charset("x-windows-949","windows-949","MS949","EUC-KR"),bytes,start,length);
            if(encoding==0) return strict(StandardCharsets.US_ASCII,bytes,start,length);
        }
        return null;
    }

    private static Map<Integer,List<String>> names(byte[] bytes,Table table) throws IOException {
        int p=table.offset,format=u16(bytes,p),count=u16(bytes,p+2),strings=u16(bytes,p+4);
        if(format>1 || count>4096 || 6L+12L*count>table.length || strings<6L+12L*count || strings>table.length) throw bad();
        Map<Integer,List<String>> names=new HashMap<>();
        // Prefer English Unicode records; keep localized names as document aliases.
        for(int pass=0;pass<3;pass++) for(int i=0;i<count;i++) {
            int at=p+6+12*i,platform=u16(bytes,at),encoding=u16(bytes,at+2),language=u16(bytes,at+4);
            int nameId=u16(bytes,at+6),length=u16(bytes,at+8),offset=u16(bytes,at+10);
            if((long)strings+offset+length>table.length) throw bad();
            boolean english=language==0x409 || language==0;
            boolean unicode=platform==0 || (platform==3 && (encoding==0 || encoding==1 || encoding==10));
            if(nameId!=1 && nameId!=2 && nameId!=4 && nameId!=6 && nameId!=16 && nameId!=17) continue;
            String text;
            if(pass==2) {
                // Older Korean fonts (1990s HY/한양, 휴먼 series) carry their Korean names only in legacy records: Windows Wansung/Johab
                // (platform 3, encoding 5/6) or Macintosh Korean (platform 1, script 3). Documents refer to those Korean names, so they
                // are added after the Unicode names. A record that does not decode is skipped; it never rejects the font.
                if(unicode || length==0 || length>2048) continue;
                text=legacyName(bytes,p+strings+offset,length,platform,encoding);
                if(text==null) continue;
            } else {
            if((pass==0)!=english || !unicode) continue;
            if(length==0) continue; if(length>2048 || (length&1)!=0) throw bad();
            try {text=StandardCharsets.UTF_16BE.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes,p+strings+offset,length)).toString();}
            catch(CharacterCodingException malformed) {throw bad();}
            }
            text=Normalizer.normalize(text,Normalizer.Form.NFC).replaceAll("[\\p{Cc}\\p{Cf}]", " ").replaceAll("\\s+"," ").trim();
            if(text.isEmpty()) continue; if(text.length()>512) {if(pass==2) continue; throw bad();}
            List<String> values=names.computeIfAbsent(nameId,key->new ArrayList<>());
            if(!values.contains(text) && values.size()<32) values.add(text);
        }
        return names;
    }
}
