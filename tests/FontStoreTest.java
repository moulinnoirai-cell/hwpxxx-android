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
            for(int i=0;i<8;i++) {
                String key=String.format(Locale.ROOT,"%064x",i);
                try(RandomAccessFile sparse=new RandomAccessFile(directory.resolve("total-budget/"+key+".sfnt").toFile(),"rw")) {
                    sparse.setLength(FontStore.MAX_FONT_BYTES);
                }
            }
            rejects(()->totalBudget.importFont(new ByteArrayInputStream(regular)),"total storage budget independent of font count");
            System.out.println("FontStore: "+checks+" checks passed (real TTF regular/bold + CFF OTF)");
        } finally {
            try(java.util.stream.Stream<Path> paths=Files.walk(directory)) {paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.deleteIfExists(path);}catch(IOException ignored){}});}
        }
    }
}
