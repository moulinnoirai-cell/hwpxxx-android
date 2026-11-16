package kr.offline.hwp;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
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

    /**
     * Shared-storage paths a content:// document MAY be: from the provider's own path column, from a storage document id
     * ("primary:Download/a.hwp", "1A2B-3C4D:a.hwp", "raw:/storage/…") and from the tail of the URI path (file-manager providers put the
     * real relative path there). These are guesses, never proof: the caller keeps one only when it resolves inside a storage root and
     * the file there holds exactly the bytes the provider returned. With that match the document is the user's own file, so Save can
     * write it back like any document opened from the list; without a match the source stays read-only.
     */
    static List<String> storagePathCandidates(String documentId,String uriPath,String dataColumn,List<String> roots){
        LinkedHashSet<String> out=new LinkedHashSet<>();
        if(roots==null||roots.isEmpty())return new ArrayList<>(out);
        if(dataColumn!=null&&dataColumn.startsWith("/"))out.add(dataColumn);
        if(documentId!=null){
            int colon=documentId.indexOf(':');
            if(colon>0&&colon<documentId.length()-1){
                String volume=documentId.substring(0,colon),rest=documentId.substring(colon+1);
                if(volume.equals("raw")){if(rest.startsWith("/"))out.add(rest);}
                else if(volume.equals("primary"))out.add(roots.get(0)+"/"+rest);
                else if(volume.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}"))out.add("/storage/"+volume+"/"+rest);
            }
        }
        if(uriPath!=null){
            int storage=uriPath.indexOf("/storage/");
            if(storage>=0)out.add(uriPath.substring(storage));
            String[] parts=uriPath.split("/");
            List<String> segments=new ArrayList<>();for(String part:parts)if(!part.isEmpty())segments.add(part);
            // Drop up to four leading provider segments ("device_storage", "external_files", "root", a user id …).
            for(int skip=0;skip<=4&&skip<segments.size();skip++){
                String tail=String.join("/",segments.subList(skip,segments.size()));
                for(String root:roots)out.add(root+"/"+tail);
            }
        }
        List<String> safe=new ArrayList<>();
        for(String path:out){
            if(safe.size()>=16)break;
            if(path.indexOf('\u0000')>=0||path.endsWith("/")||("/"+path+"/").contains("/../")||("/"+path+"/").contains("/./"))continue;
            safe.add(path);
        }
        return safe;
    }

    /** Only content:// documents may enter through an Intent. file://, http(s), intent: and everything else is refused. */
    static boolean acceptableIncomingScheme(String scheme){return "content".equals(scheme);}
    static boolean acceptableIncomingAction(String action){return "android.intent.action.VIEW".equals(action)||"android.intent.action.EDIT".equals(action)||"android.intent.action.SEND".equals(action);}
}
