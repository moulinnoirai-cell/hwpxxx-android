package kr.offline.hwp;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Pure rules for the page-facing private state (document history, recent documents). No Android types, so the JVM test covers them. */
final class HostState {
    private HostState(){}
    static final int MAX_HISTORY=24,MAX_RECENT=30,MAX_META=4096;
    /** Text plus HTML travel through the system clipboard service (one Binder transaction, ~1 MiB shared) and through one bridge message: stay far below both. */
    static final int MAX_CLIPBOARD_BYTES=256*1024;
    static boolean clipboardWithinLimit(String text,String html){
        long total=(text==null?0:(long)text.getBytes(StandardCharsets.UTF_8).length)+(html==null?0:(long)html.getBytes(StandardCharsets.UTF_8).length);
        return total<=MAX_CLIPBOARD_BYTES;
    }

    /** Ids come from Studio (random/uuid-like). Only a conservative character set and length reach the store. */
    static boolean validHistoryId(String id){return id!=null&&id.matches("[A-Za-z0-9._:-]{1,128}");}
    static boolean validRecentId(String id){return id!=null&&id.matches("[0-9a-f]{64}");}
    /** History metadata is a small JSON object; the glue parses it again, this only bounds and shapes it. */
    static boolean validMeta(String json){
        if(json==null)return false;String t=json.trim();
        return t.length()>1&&t.charAt(0)=='{'&&t.charAt(t.length()-1)=='}'&&t.getBytes(StandardCharsets.UTF_8).length<=MAX_META;
    }
    /** Opaque, stable id of a recent-document source (so reopening the same file replaces its entry instead of adding another). */
    static String recentId(String sourceKey){
        try{
            byte[] digest=MessageDigest.getInstance("SHA-256").digest(("recent\0"+sourceKey).getBytes(StandardCharsets.UTF_8));
            StringBuilder out=new StringBuilder();for(byte b:digest)out.append(String.format(Locale.ROOT,"%02x",b));return out.toString();
        }catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
    }
    /** Native errors the page must tell apart travel as "[Code] message" (the reply channel only carries strings). */
    static String coded(String code,String message){return "["+code+"] "+message;}
    static String codeOf(String error){
        if(error==null||!error.startsWith("["))return "";int end=error.indexOf(']');return end<2?"":error.substring(1,end);
    }
}
