package kr.offline.hwp;

import java.io.File;
import java.nio.file.Files;
import java.util.UUID;

/** Pruning logic only (the provider's file name rule and retention). Run with android.jar on the classpath; no Android runtime is started. */
public class ClipboardImageProviderTest {
    static int checks;
    static void yes(boolean value,String what){if(!value)throw new AssertionError(what);checks++;}
    public static void main(String[] arguments)throws Exception {
        File dir=Files.createTempDirectory("clip-test-").toFile();
        File[] images=new File[6];
        for(int i=0;i<images.length;i++){images[i]=new File(dir,UUID.randomUUID()+".png");Files.write(images[i].toPath(),new byte[]{(byte)137,80,78,71,13,10,26,10});yes(images[i].setLastModified(1_700_000_000_000L+i*1000L),"mtime");}
        File foreign=new File(dir,"notes.txt"),shortName=new File(dir,"0123.png"),upper=new File(dir,UUID.randomUUID().toString().toUpperCase()+".png");
        for(File f:new File[]{foreign,shortName,upper})Files.write(f.toPath(),new byte[]{1});
        ClipboardImageProvider.prune(dir,3);
        int left=0;for(File f:images)if(f.exists())left++;
        yes(left==3,"keeps the newest 3 opaque images, left "+left);
        yes(images[5].exists()&&images[4].exists()&&images[3].exists()&&!images[0].exists(),"newest survive, oldest removed");
        yes(foreign.exists()&&shortName.exists()&&upper.exists(),"files that do not match the opaque name rule are never touched");
        ClipboardImageProvider.prune(dir,0);
        for(File f:images)yes(!f.exists(),"prune(0) removes every opaque image");
        yes(foreign.exists(),"foreign file still untouched");
        for(File f:dir.listFiles())f.delete();dir.delete();
        System.out.println("ClipboardImageProvider: "+checks+" checks passed");
    }
}
