package kr.offline.hwp;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Pure decisions for what other apps may hand to the editor. Nothing here touches Android, so the JVM test covers it. */
final class HostIntents {
    private HostIntents(){}

    /**
     * Which document format an incoming file is. Names without a usable extension (some providers send "download" or an id) are
     * recognised from the MIME type, then from the first bytes; the bytes are validated again by the normal document validator.
     */
    static String documentFormat(String displayName,String mime,byte[] head){
        String ext=extension(displayName);
        if(ext.equals("hwp")||ext.equals("hwpx")||ext.equals("hml"))return ext;
        String type=mime==null?"":mime.toLowerCase(Locale.ROOT);
        if(type.contains("hwpx"))return "hwpx";
        if(type.contains("hml"))return "hml";
        if(type.contains("hwp")||type.contains("haansoft"))return "hwp";
        if(head!=null){
            if(head.length>=8&&(head[0]&0xff)==0xd0&&(head[1]&0xff)==0xcf&&(head[2]&0xff)==0x11&&(head[3]&0xff)==0xe0&&(head[4]&0xff)==0xa1&&(head[5]&0xff)==0xb1&&(head[6]&0xff)==0x1a&&(head[7]&0xff)==0xe1)return "hwp";
            if(head.length>=4&&head[0]=='P'&&head[1]=='K'&&head[2]==3&&head[3]==4)return "hwpx";
            String start=new String(head,0,Math.min(head.length,64),StandardCharsets.UTF_8).replace("\uFEFF","").trim();
            if(start.startsWith("<"))return "hml";
        }
        return null;
    }
    /** The name shown in Studio always carries the extension the format needs (it decides open/save rules downstream). */
    static String nameWithExtension(String displayName,String format){
        String name=displayName==null||displayName.trim().isEmpty()?"문서":displayName.trim();
        return extension(name).equals(format)?name:name+"."+format;
    }
    private static String extension(String name){if(name==null)return "";int dot=name.lastIndexOf('.');return dot<0?"":name.substring(dot+1).toLowerCase(Locale.ROOT);}

    /** Only content:// documents may enter through an Intent. file://, http(s), intent: and everything else is refused. */
    static boolean acceptableIncomingScheme(String scheme){return "content".equals(scheme);}
    static boolean acceptableIncomingAction(String action){return "android.intent.action.VIEW".equals(action)||"android.intent.action.EDIT".equals(action)||"android.intent.action.SEND".equals(action);}
}
