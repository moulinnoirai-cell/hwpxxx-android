package kr.offline.hwp;

public class HostStateTest {
    static int checks;
    static void yes(boolean value,String what){if(!value)throw new AssertionError(what);checks++;}
    public static void main(String[] arguments){
        for(String ok:new String[]{"a","snap-1","0f8e2c1a-1234-4abc-9def-0123456789ab","doc.v2:3_x"})yes(HostState.validHistoryId(ok),"id ok "+ok);
        for(String bad:new String[]{null,"","a/b","../x","a b","a\n","한글","x".repeat(129)})yes(!HostState.validHistoryId(bad),"id refused "+bad);
        yes(HostState.validMeta("{\"id\":\"a\"}")&&HostState.validMeta(" {\"a\":[1,2]} "),"meta ok");
        yes(!HostState.validMeta(null)&&!HostState.validMeta("")&&!HostState.validMeta("[]")&&!HostState.validMeta("{")&&!HostState.validMeta("text")&&!HostState.validMeta("{"+"a".repeat(HostState.MAX_META)+"}"),"meta refused");
        yes(!HostState.validMeta("{\""+"한".repeat(1400)+"\":1}"),"meta limit counts UTF-8 bytes, not characters");
        String a=HostState.recentId("path:/sdcard/Documents/a.hwp"),b=HostState.recentId("path:/sdcard/Documents/a.hwp"),c=HostState.recentId("path:/sdcard/Documents/b.hwp");
        yes(a.equals(b)&&!a.equals(c)&&HostState.validRecentId(a),"recent id is stable, distinct and well-formed");
        yes(!HostState.validRecentId("../x")&&!HostState.validRecentId(a.toUpperCase())&&!HostState.validRecentId(a+"0")&&!HostState.validRecentId(null),"recent id refused");
        yes(!a.contains("sdcard")&&!a.contains("a.hwp"),"id leaks no path");
        yes("NotFound".equals(HostState.codeOf(HostState.coded("NotFound","없어요")))&&"NotAllowed".equals(HostState.codeOf("[NotAllowed] x"))&&"".equals(HostState.codeOf("평범한 오류"))&&"".equals(HostState.codeOf("[] x"))&&"".equals(HostState.codeOf(null)),"error codes");
        yes(HostState.clipboardWithinLimit("가나다","<b>x</b>")&&HostState.clipboardWithinLimit(null,null)&&HostState.clipboardWithinLimit("a".repeat(HostState.MAX_CLIPBOARD_BYTES),""),"clipboard within limit");
        yes(!HostState.clipboardWithinLimit("a".repeat(HostState.MAX_CLIPBOARD_BYTES),"b")&&!HostState.clipboardWithinLimit("a".repeat(200000),"b".repeat(200000)),"combined text+html over the limit is refused");
        yes(!HostState.clipboardWithinLimit("한".repeat(90000),""),"limit counts UTF-8 bytes (3 per Hangul), not characters");
        System.out.println("HostState: "+checks+" checks passed");
    }
}
