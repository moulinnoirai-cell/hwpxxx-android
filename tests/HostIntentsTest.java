package kr.offline.hwp;

public class HostIntentsTest {
    static int checks;
    static void yes(boolean value,String what){if(!value)throw new AssertionError(what);checks++;}
    public static void main(String[] arguments)throws Exception {
        // incoming documents: only content:// with VIEW/EDIT/SEND
        yes(HostIntents.acceptableIncomingScheme("content"),"content ok");
        for(String scheme:new String[]{"file","http","https","intent","javascript",null,""})yes(!HostIntents.acceptableIncomingScheme(scheme),"scheme refused "+scheme);
        yes(HostIntents.acceptableIncomingAction("android.intent.action.VIEW")&&HostIntents.acceptableIncomingAction("android.intent.action.EDIT")&&HostIntents.acceptableIncomingAction("android.intent.action.SEND"),"actions");
        for(String action:new String[]{"android.intent.action.MAIN","android.intent.action.SEND_MULTIPLE","android.intent.action.DELETE",null})yes(!HostIntents.acceptableIncomingAction(action),"action refused "+action);
        // format recognition: extension first, then MIME, then magic bytes
        yes("hwp".equals(HostIntents.documentFormat("보고서.HWP",null,null)),"ext hwp");
        yes("hwpx".equals(HostIntents.documentFormat("a.hwpx","application/octet-stream",null)),"ext hwpx");
        yes("hml".equals(HostIntents.documentFormat("a.hml",null,null)),"ext hml");
        yes("hwpx".equals(HostIntents.documentFormat("download","application/vnd.hancom.hwpx",null)),"mime hwpx");
        yes("hwp".equals(HostIntents.documentFormat("1234","application/x-hwp",null)),"mime hwp");
        yes("hwp".equals(HostIntents.documentFormat("1234","application/haansofthwp",null)),"mime haansoft");
        yes("hwp".equals(HostIntents.documentFormat("1234","",new byte[]{(byte)0xd0,(byte)0xcf,0x11,(byte)0xe0,(byte)0xa1,(byte)0xb1,0x1a,(byte)0xe1,0})),"ole magic");
        yes("hwpx".equals(HostIntents.documentFormat("1234",null,new byte[]{'P','K',3,4,0})),"zip magic");
        yes("hml".equals(HostIntents.documentFormat("1234",null,"﻿ <HWPML/>".getBytes("UTF-8"))),"xml magic");
        yes(HostIntents.documentFormat("1234","image/png",new byte[]{(byte)137,'P','N','G'})==null,"png is not a document");
        yes(HostIntents.documentFormat("note.txt","text/plain","hello".getBytes("UTF-8"))==null,"text is not a document");
        yes(HostIntents.documentFormat(null,null,null)==null,"nothing known");
        yes(HostIntents.nameWithExtension("1234","hwp").equals("1234.hwp")&&HostIntents.nameWithExtension("a.hwp","hwp").equals("a.hwp")&&HostIntents.nameWithExtension(" ","hwpx").equals("문서.hwpx")&&HostIntents.nameWithExtension(null,"hml").equals("문서.hml"),"names carry an extension");
        System.out.println("HostIntents: "+checks+" checks passed");
    }
}
