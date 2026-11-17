package kr.offline.hwp;

import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Run with three redistributable installed fonts: regular TTF, bold TTF, CFF OTF. */
public final class FontStoreTest {
    private static int checks;
    private static void yes(boolean value,String label) {if(!value)throw new AssertionError(label);checks++;}
    private interface Run {void run() throws Exception;}
    private static void rejects(Run operation,String label) throws Exception {
        try {operation.run();} catch(IOException expected) {checks++;return;}
        throw new AssertionError("Expected IOException: "+label);
    }
    private static int u16(byte[] b,int at) {return ((b[at]&255)<<8)|(b[at+1]&255);}
    private static int u32(byte[] b,int at) {return (u16(b,at)<<16)|u16(b,at+2);}
    private static void put16(byte[] b,int at,int value) {b[at]=(byte)(value>>>8);b[at+1]=(byte)value;}
    private static void put32(byte[] b,int at,int value) {put16(b,at,value>>>16);put16(b,at+2,value);}
    private static int table(byte[] b,String name) {
        for(int i=0;i<u16(b,4);i++) {int at=12+16*i;if(new String(b,at,4,java.nio.charset.StandardCharsets.ISO_8859_1).equals(name))return at;}
        throw new AssertionError("fixture missing "+name);
    }
    private interface Mutate {void change(byte[] b);}
    private static void malformed(FontStore store,byte[] original,Mutate change,String label) throws Exception {
        byte[] bytes=original.clone();change.change(bytes);rejects(()->store.importFont(new ByteArrayInputStream(bytes)),label);
    }
    private static String revision(FontStore store) throws IOException {return (String)store.snapshot().get("revision");}


    // ---- collections (.ttc), unaligned fonts, legacy (pre-Unicode) Korean names -------------------------------------------------------
    private static LinkedHashMap<String,byte[]> tables(byte[] font) {
        LinkedHashMap<String,byte[]> out=new LinkedHashMap<>();
        for(int i=0;i<u16(font,4);i++) {int at=12+16*i;int offset=u32(font,at+8),length=u32(font,at+12);
            out.put(new String(font,at,4,java.nio.charset.StandardCharsets.ISO_8859_1),Arrays.copyOfRange(font,offset,offset+length));}
        return out;
    }
    /** Lays tables out after {@code base} bytes; {@code skew} shifts every table off the 4-byte grid. Offsets are absolute (base included). */
    private static byte[] layout(LinkedHashMap<String,byte[]> tables,int signature,int base,int skew) {
        int size=12+16*tables.size();for(byte[] t:tables.values())size+=((t.length+3)&~3)+skew;
        byte[] out=new byte[size];put32(out,0,signature);put16(out,4,tables.size());
        int record=12,data=12+16*tables.size();
        for(Map.Entry<String,byte[]> e:tables.entrySet()) {
            data+=skew;System.arraycopy(e.getKey().getBytes(java.nio.charset.StandardCharsets.ISO_8859_1),0,out,record,4);
            put32(out,record+8,base+data);put32(out,record+12,e.getValue().length);
            System.arraycopy(e.getValue(),0,out,data,e.getValue().length);record+=16;data+=(e.getValue().length+3)&~3;
        }
        return out;
    }
    private static byte[] collection(int version,byte[]... fonts) {
        int header=12+4*fonts.length,size=header;for(byte[] f:fonts)size+=f.length;
        byte[] out=new byte[size];put32(out,0,0x74746366);put32(out,4,version);put32(out,8,fonts.length);
        int at=header;
        for(int i=0;i<fonts.length;i++) {put32(out,12+4*i,at);System.arraycopy(layout(tables(fonts[i]),u32(fonts[i],0),at,0),0,out,at,fonts[i].length);at+=fonts[i].length;}
        return out;
    }
    private static long sum(byte[] b) {long s=0;for(int p=0;p<b.length;p+=4){long v=0;for(int i=0;i<4;i++)v=(v<<8)|(p+i<b.length?(b[p+i]&255):0);s+=v;}return s&0xffffffffL;}
    private static byte[] nameTable(int[][] ids,byte[][] strings) {
        int size=6+12*ids.length;for(byte[] t:strings)size+=t.length;
        byte[] out=new byte[size];put16(out,2,ids.length);put16(out,4,6+12*ids.length);int offset=0;
        for(int i=0;i<ids.length;i++) {int at=6+12*i;put16(out,at,ids[i][0]);put16(out,at+2,ids[i][1]);put16(out,at+4,ids[i][2]);put16(out,at+6,ids[i][3]);
            put16(out,at+8,strings[i].length);put16(out,at+10,offset);System.arraycopy(strings[i],0,out,6+12*ids.length+offset,strings[i].length);offset+=strings[i].length;}
        return out;
    }
    /** Windows legacy form: two bytes per character, single-byte characters get a zero high byte. */
    private static byte[] wansung(String text) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        for(int i=0;i<text.length();i++) {byte[] one=text.substring(i,i+1).getBytes("x-windows-949");if(one.length==1)out.write(0);out.write(one);}
        return out.toByteArray();
    }

    private static void collectionsAndLegacyFonts(Path directory,byte[] regular,byte[] bold) throws Exception {
        FontStore direct=new FontStore(directory.resolve("ttc-direct").toFile());
        FontStore.Face r=direct.importFont(new ByteArrayInputStream(regular)),b=direct.importFont(new ByteArrayInputStream(bold));

        FontStore store=new FontStore(directory.resolve("ttc").toFile());
        byte[] ttc=collection(0x00020000,regular,bold);
        List<FontStore.Face> faces=store.importFonts(new ByteArrayInputStream(ttc));
        yes(faces.size()==2&&store.list().size()==2,"a collection yields one stored face per member");
        yes(faces.get(0).family.equals(r.family)&&faces.get(0).weight==r.weight&&faces.get(1).weight==b.weight&&faces.get(1).fullName.equals(b.fullName),"member metadata equals the standalone fonts");
        String revision=revision(store);
        for(int i=0;i<2;i++) {
            byte[] member=store.read(faces.get(i).id,revision),source=i==0?regular:bold;
            LinkedHashMap<String,byte[]> want=tables(source),have=tables(member);want.remove("DSIG");
            yes(have.keySet().equals(new TreeSet<>(want.keySet()))&&new ArrayList<>(have.keySet()).equals(new ArrayList<>(new TreeSet<>(want.keySet()))),"same tables, sorted by tag");
            for(String tag:want.keySet()) {
                byte[] w=want.get(tag).clone(),h=have.get(tag).clone();
                if(tag.equals("head")){put32(w,8,0);put32(h,8,0);}// checkSumAdjustment is recomputed for the new file
                yes(Arrays.equals(w,h),"table bytes are copied unchanged: "+tag);
            }
            for(int t=0;t<u16(member,4);t++) yes((u32(member,12+16*t+8)&3)==0,"member tables are 4-byte aligned");
            yes(sum(member)==0xB1B0AFBAL,"whole-file checksum matches head.checkSumAdjustment");
        }
        yes(store.importFonts(new ByteArrayInputStream(ttc)).size()==2&&store.list().size()==2,"the same collection again adds nothing");
        yes(store.importFont(new ByteArrayInputStream(ttc)).id.equals(faces.get(0).id),"importFont returns the first member");

        // Members that share one table directory offset are imported once; version 1.0 headers work too.
        byte[] twice=collection(0x00010000,regular,regular);put32(twice,16,u32(twice,12));
        yes(new FontStore(directory.resolve("ttc-shared").toFile()).importFonts(new ByteArrayInputStream(twice)).size()==1,"duplicate member offsets are one face");

        FontStore strict=new FontStore(directory.resolve("ttc-bad").toFile());
        byte[] badVersion=ttc.clone();put32(badVersion,4,0x00030000);rejects(()->strict.importFonts(new ByteArrayInputStream(badVersion)),"unknown collection version");
        byte[] none=ttc.clone();put32(none,8,0);rejects(()->strict.importFonts(new ByteArrayInputStream(none)),"empty collection");
        byte[] many=ttc.clone();put32(many,8,FontStore.MAX_COLLECTION_FACES+1);rejects(()->strict.importFonts(new ByteArrayInputStream(many)),"too many members");
        byte[] outside=ttc.clone();put32(outside,16,ttc.length-4);rejects(()->strict.importFonts(new ByteArrayInputStream(outside)),"member directory outside the file");
        byte[] broken=ttc.clone();int second=u32(broken,16);put32(broken,second+12+8,ttc.length);rejects(()->strict.importFonts(new ByteArrayInputStream(broken)),"member table outside the file");
        yes(strict.list().isEmpty(),"a collection with one bad member stores nothing");
        try {strict.importFonts(new ByteArrayInputStream(new byte[]{'w','O','F','F',0,1,0,0,0,0,0,0,0,0,0,0}));throw new AssertionError("WOFF accepted");}
        catch(IOException e) {yes(e.getMessage().contains("WOFF"),"WOFF is named in the refusal");}

        // A file whose faces do not all fit is refused as a whole.
        FontStore nearlyFull=new FontStore(directory.resolve("ttc-full").toFile());
        for(int i=0;i<FontStore.MAX_FONTS-1;i++) {byte[] variant=Arrays.copyOf(regular,regular.length+4);put32(variant,regular.length,i);nearlyFull.importFont(new ByteArrayInputStream(variant));}
        rejects(()->nearlyFull.importFonts(new ByteArrayInputStream(ttc)),"two new faces do not fit in one free slot");
        yes(nearlyFull.list().size()==FontStore.MAX_FONTS-1,"nothing of the refused collection was stored");

        // Fonts whose tables are off the 4-byte grid (some 1990s fonts) are rewritten aligned instead of refused.
        byte[] skewed=layout(tables(regular),u32(regular,0),0,1);
        FontStore aligned=new FontStore(directory.resolve("skewed").toFile());
        FontStore.Face fixed=aligned.importFont(new ByteArrayInputStream(skewed));
        byte[] rewritten=aligned.read(fixed.id,revision(aligned));
        yes(fixed.family.equals(r.family)&&!Arrays.equals(rewritten,skewed)&&sum(rewritten)==0xB1B0AFBAL,"an unaligned font is stored as an aligned rewrite");
        for(int t=0;t<u16(rewritten,4);t++) yes((u32(rewritten,12+16*t+8)&3)==0,"rewritten tables are aligned");

        // Korean names kept only in legacy records: Windows Wansung (3,5) and Macintosh Korean (1,3).
        if(java.nio.charset.Charset.isSupported("x-windows-949")) {
            LinkedHashMap<String,byte[]> legacy=tables(regular);
            legacy.put("name",nameTable(new int[][]{{3,5,0x412,1},{3,5,0x412,2},{1,3,23,4},{3,5,0x412,6},{3,5,0x412,4}},
                new byte[][]{wansung("HY견고딕"),wansung("Regular"),"HY견고딕 보통".getBytes("x-windows-949"),wansung("HYGothic-Extra"),new byte[]{(byte)0xff,(byte)0xff,(byte)0xff}}));
            FontStore old=new FontStore(directory.resolve("legacy-names").toFile());
            FontStore.Face hy=old.importFont(new ByteArrayInputStream(layout(legacy,u32(regular,0),0,0)));
            yes(hy.family.equals("HY견고딕")&&hy.style.equals("Regular")&&hy.postscriptName.equals("HYGothic-Extra"),"legacy Wansung names are decoded: "+hy.family+"/"+hy.style+"/"+hy.postscriptName);
            yes(hy.fullName.equals("HY견고딕 보통")&&hy.aliases.contains("HY견고딕"),"Macintosh Korean name is decoded and an undecodable record is skipped: "+hy.fullName);
            // Unicode names stay first; legacy names are added as aliases.
            LinkedHashMap<String,byte[]> both=tables(regular);
            both.put("name",nameTable(new int[][]{{3,1,0x409,1},{3,5,0x412,1},{3,5,0x412,1}},
                new byte[][]{"HYGothic".getBytes(java.nio.charset.StandardCharsets.UTF_16BE),wansung("HY견고딕"),"HY중고딕".getBytes(java.nio.charset.StandardCharsets.UTF_16BE)}));
            FontStore.Face mixed=old.importFont(new ByteArrayInputStream(layout(both,u32(regular,0),0,0)));
            yes(mixed.family.equals("HYGothic")&&mixed.aliases.contains("HY견고딕")&&mixed.aliases.contains("HY중고딕"),"Unicode name first, legacy and mislabelled UTF-16 names as aliases: "+mixed.aliases);
        } else System.out.println("legacy name checks skipped: this JVM has no x-windows-949 charset");
    }

    public static void main(String[] args) throws Exception {
        if(args.length<3 || args.length>4) throw new IllegalArgumentException("regular.ttf bold.ttf cff.otf [korean.ttf] required");
        byte[] regular=Files.readAllBytes(Paths.get(args[0])),bold=Files.readAllBytes(Paths.get(args[1])),otf=Files.readAllBytes(Paths.get(args[2]));
        Path directory=Files.createTempDirectory("hwp-font-tests-");
        try {
            FontStore fonts=new FontStore(directory.resolve("fonts").toFile());
            yes(fonts.list().isEmpty(),"new empty catalog");String empty=revision(fonts);
            FontStore.Face a=fonts.importFont(new ByteArrayInputStream(regular));
            yes(a.id.matches("[0-9a-f]{64}")&&!a.family.isEmpty()&&!a.fullName.isEmpty(),"real TTF metadata and opaque ID");
            yes(a.weight==400 && a.slant.equals("normal"),"real regular style");
            yes(!a.aliases.isEmpty()&&a.aliases.contains(a.family),"actual SFNT aliases");
            yes(!a.toMap().containsKey("path")&&!a.toMap().containsKey("uri"),"no source authority in metadata");
            String one=revision(fonts);yes(!one.equals(empty),"import changes revision");
            yes(Arrays.equals(regular,fonts.read(a.id,one)),"real bytes round trip");
            yes(fonts.importFont(new ByteArrayInputStream(regular)).id.equals(a.id)&&fonts.list().size()==1,"content deduplication");
            yes(revision(fonts).equals(one),"duplicate keeps revision stable");
            FontStore reopened=new FontStore(directory.resolve("fonts").toFile());
            yes(revision(reopened).equals(one)&&Arrays.equals(regular,reopened.read(a.id,one)),"persistent registry survives new store instance");
            FontStore.Face b=fonts.importFont(new ByteArrayInputStream(bold));
            yes(b.weight==700 && b.family.equals(a.family)&&!a.id.equals(b.id),"real bold face retained separately");
            rejects(()->fonts.read(a.id,one),"old revision after import");
            FontStore.Face c=fonts.importFont(new ByteArrayInputStream(otf));
            yes(!c.family.isEmpty()&&Arrays.equals(otf,fonts.read(c.id,revision(fonts))),"real CFF OpenType round trip");
            rejects(()->fonts.read("../../etc/passwd",revision(fonts)),"read traversal");
            rejects(()->fonts.delete("../escape"),"delete traversal");
            rejects(()->fonts.read(a.id,"unknown"),"unknown revision");
            rejects(()->fonts.importFont(null),"null stream");
            rejects(()->fonts.importFont(new ByteArrayInputStream(new byte[0])),"empty font");
            rejects(()->fonts.importFont(new ByteArrayInputStream(new byte[12])),"fake zero header");
            malformed(fonts,regular,bits->put32(bits,0,0x74746366),"TTC is unsupported");
            malformed(fonts,regular,bits->put32(bits,0,0x774f4646),"WOFF is unsupported");
            malformed(fonts,regular,bits->put16(bits,4,257),"table count bound");
            malformed(fonts,regular,bits->put32(bits,20,0xfffffff0),"unsigned table offset overflow");
            malformed(fonts,regular,bits->put32(bits,24,0x7fffffff),"table length overflow");
            malformed(fonts,regular,bits->System.arraycopy(bits,12,bits,28,4),"duplicate table tags");
            malformed(fonts,regular,bits->put32(bits,36,u32(bits,20)),"overlapping tables");
            malformed(fonts,regular,bits->put32(bits,20,4),"table points into directory");
            malformed(fonts,regular,bits->put32(bits,u32(bits,table(bits,"head")+8)+12,0),"bad head magic");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"head")+8)+18,0),"invalid units per em");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"maxp")+8)+4,0),"zero glyph count");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"hhea")+8)+34,0),"zero metrics");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"head")+8)+50,2),"invalid loca format");
            malformed(fonts,regular,bits->put32(bits,u32(bits,table(bits,"cmap")+8)+8,0x7fffffff),"cmap subtable outside table");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"name")+8)+4,0),"name strings overlap records");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"name")+8)+6+8,65535),"name string out of bounds");
            malformed(fonts,regular,bits->put16(bits,u32(bits,table(bits,"OS/2")+8)+4,1001),"invalid font weight");
            malformed(fonts,otf,bits->bits[u32(bits,table(bits,"CFF ")+8)]=0,"invalid CFF header");
            malformed(fonts,regular,bits->{
                int at=u32(bits,table(bits,"name")+8),strings=u16(bits,at+4);
                for(int i=0;i<u16(bits,at+2);i++) {int record=at+6+12*i,platform=u16(bits,record),name=u16(bits,record+6);
                    if((platform==0||platform==3) && name==1 && u16(bits,record+8)>=2) {
                        put16(bits,at+strings+u16(bits,record+10),0xd800); break;}}
            },"malformed Unicode font name");
            rejects(()->fonts.importFont(new ByteArrayInputStream(Arrays.copyOf(regular,regular.length/2))),"truncated real TTF");
            rejects(()->fonts.importFont(new InputStream() {
                int remaining=FontStore.MAX_FONT_BYTES+1;
                public int read(){return remaining-- >0?0:-1;}
                public int read(byte[] target,int offset,int length){if(remaining<=0)return -1;int n=Math.min(remaining,length);Arrays.fill(target,offset,offset+n,(byte)0);remaining-=n;return n;}
            }),"stream hard size bound");
            rejects(()->fonts.importFont(new InputStream(){public int read()throws IOException{throw new IOException("SAF provider failed");}}),"provider failure");
            yes(fonts.list().size()==3,"rejected imports preserve catalog");
            // Integrity is checked at every listing/read, including when a same-size copy changes.
            Path af=directory.resolve("fonts/"+a.id+".sfnt");byte[] corrupt=regular.clone();corrupt[corrupt.length-1]^=1;Files.write(af,corrupt);
            yes(fonts.list().size()==2,"corrupt copy omitted");
            rejects(()->fonts.read(a.id,revision(fonts)),"corrupt bytes never returned");
            Files.write(af,regular);yes(fonts.list().size()==3,"restored copy validated");
            Path symlink=directory.resolve("fonts/"+String.join("",Collections.nCopies(64,"a"))+".sfnt");
            Files.createSymbolicLink(symlink,Paths.get(args[0]));
            yes(fonts.list().size()==3,"symlink catalog entry ignored");
            rejects(()->fonts.read(String.join("",Collections.nCopies(64,"a")),revision(fonts)),"symlink read rejected");
            rejects(()->new FontStore(symlink.toFile()),"symlink root rejected");
            Files.delete(symlink);
            yes(fonts.delete(b.id)&&!fonts.delete(b.id),"delete is persistent and idempotent");
            rejects(()->fonts.read(b.id,revision(fonts)),"deleted font unavailable");
            yes(new FontStore(directory.resolve("fonts").toFile()).list().size()==2,"delete survives reopening");
            try(java.util.stream.Stream<Path> files=Files.list(directory.resolve("fonts"))) {
                yes(files.noneMatch(path->path.getFileName().toString().startsWith(".font-")),"no incomplete imports visible or left behind");
            }
            // Count budget is enforced on actual copies, before writing another file.
            FontStore bounded=new FontStore(directory.resolve("count-budget").toFile());
            for(int i=0;i<FontStore.MAX_FONTS;i++) {byte[] variant=Arrays.copyOf(regular,regular.length+4);put32(variant,regular.length,i);bounded.importFont(new ByteArrayInputStream(variant));}
            rejects(()->bounded.importFont(new ByteArrayInputStream(bold)),"count budget");
            yes(bounded.list().size()==FontStore.MAX_FONTS,"count budget preserves all existing fonts");
            if(args.length==4) {
                byte[] korean=Files.readAllBytes(Paths.get(args[3]));
                FontStore koreanStore=new FontStore(directory.resolve("korean-font").toFile());
                FontStore.Face k=koreanStore.importFont(new ByteArrayInputStream(korean));
                yes(k.family.equals("Noto Sans KR") && k.aliases.contains("Noto Sans KR"),"bundled Korean font real family and aliases");
                yes(Arrays.equals(korean,koreanStore.read(k.id,revision(koreanStore))),"bundled Korean font bytes validated intact");
                System.out.println("Bundled Korean font: "+korean.length+" bytes; family="+k.family+"; aliases="+k.aliases);
            }
            FontStore totalBudget=new FontStore(directory.resolve("total-budget").toFile());
            for(int i=0;i<FontStore.MAX_TOTAL_BYTES/FontStore.MAX_FONT_BYTES;i++) {
                String key=String.format(Locale.ROOT,"%064x",i);
                try(RandomAccessFile sparse=new RandomAccessFile(directory.resolve("total-budget/"+key+".sfnt").toFile(),"rw")) {
                    sparse.setLength(FontStore.MAX_FONT_BYTES);
                }
            }
            rejects(()->totalBudget.importFont(new ByteArrayInputStream(regular)),"total storage budget independent of font count");
            collectionsAndLegacyFonts(directory,regular,bold);
            System.out.println("FontStore: "+checks+" checks passed (real TTF regular/bold + CFF OTF)");
        } finally {
            try(java.util.stream.Stream<Path> paths=Files.walk(directory)) {paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.deleteIfExists(path);}catch(IOException ignored){}});}
        }
    }
}
