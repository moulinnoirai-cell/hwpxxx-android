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
        // Recognized extensions take priority. PDF/HWP3 signatures identify files with missing or inaccurate metadata.
        yes("hwp".equals(HostIntents.documentFormat("보고서.HWP",null,null)),"ext hwp");
        yes("hwpx".equals(HostIntents.documentFormat("a.hwpx","application/octet-stream",null)),"ext hwpx");
        yes("hml".equals(HostIntents.documentFormat("a.hml",null,null)),"ext hml");
        yes("pdf".equals(HostIntents.documentFormat("a.PDF",null,null)),"ext pdf");
        yes("pdf".equals(HostIntents.documentFormat(null,"application/pdf",null)),"mime pdf");
        byte[] pdf="%PDF-1.7".getBytes("US-ASCII"),hwp3="HWP Document File V3.00".getBytes("US-ASCII");
        yes("pdf".equals(HostIntents.documentFormat(null,"application/octet-stream",pdf)),"nameless pdf magic");
        yes("hwp".equals(HostIntents.documentFormat(null,null,hwp3)),"nameless hwp3 magic");
        yes("hwp".equals(HostIntents.documentFormat("download","text/html",hwp3)),"hwp3 magic with generic provider name");
        yes("문서.pdf".equals(HostIntents.nameWithExtension(null,"pdf")),"nameless pdf gets a PDF extension");
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
        // content:// -> shared-storage path candidates (guesses only; MainActivity keeps one only after a byte-for-byte match inside a root)
        java.util.List<String> roots=java.util.Arrays.asList("/storage/emulated/0","/storage/1A2B-3C4D");
        yes(HostIntents.storagePathCandidates("primary:Download/보고서.hwp",null,null,roots).contains("/storage/emulated/0/Download/보고서.hwp"),"primary document id");
        yes(HostIntents.storagePathCandidates("1A2B-3C4D:문서/a.hwpx",null,null,roots).contains("/storage/1A2B-3C4D/문서/a.hwpx"),"removable volume document id");
        yes(HostIntents.storagePathCandidates("raw:/storage/emulated/0/Download/a.hwp",null,null,roots).contains("/storage/emulated/0/Download/a.hwp"),"raw document id");
        yes(HostIntents.storagePathCandidates("msf:1234",null,null,roots).isEmpty()&&HostIntents.storagePathCandidates("1234",null,null,roots).isEmpty()&&HostIntents.storagePathCandidates("primary:",null,null,roots).isEmpty(),"opaque ids give nothing");
        yes(HostIntents.storagePathCandidates(null,null,"/storage/emulated/0/DCIM/a.hwp",roots).get(0).equals("/storage/emulated/0/DCIM/a.hwp"),"provider path column first");
        yes(HostIntents.storagePathCandidates(null,null,"relative/a.hwp",roots).isEmpty(),"relative path column ignored");
        yes(HostIntents.storagePathCandidates(null,"/device_storage/Download/a.hwp",null,roots).contains("/storage/emulated/0/Download/a.hwp"),"file-manager provider path, one leading segment");
        yes(HostIntents.storagePathCandidates(null,"/external_files/0/Documents/업무/a.hwp",null,roots).contains("/storage/emulated/0/Documents/업무/a.hwp"),"two leading segments");
        yes(HostIntents.storagePathCandidates(null,"/root/storage/emulated/0/Download/a.hwp",null,roots).get(0).equals("/storage/emulated/0/Download/a.hwp"),"absolute path inside the URI");
        yes(HostIntents.storagePathCandidates(null,"/x/Download/a.hwp",null,roots).contains("/storage/1A2B-3C4D/Download/a.hwp"),"every root is tried");
        for(String path:HostIntents.storagePathCandidates("primary:../../data/a.hwp","/a/../b/./c.hwp","/storage/emulated/0/../x.hwp",roots))yes(!("/"+path+"/").contains("/../")&&!("/"+path+"/").contains("/./"),"no dot segments: "+path);
        yes(HostIntents.storagePathCandidates("primary:../../data/a.hwp",null,"/storage/emulated/0/../x.hwp",roots).isEmpty(),"traversal candidates dropped");
        yes(HostIntents.storagePathCandidates("primary:a.hwp","/a.hwp","/x/a.hwp",null).isEmpty()&&HostIntents.storagePathCandidates("primary:a.hwp","/a.hwp","/x/a.hwp",new java.util.ArrayList<String>()).isEmpty(),"no roots, no candidates");
        yes(HostIntents.storagePathCandidates(null,"/a/b/c/d/e/f/g/h/i/j.hwp",null,roots).size()<=16,"bounded");
        System.out.println("HostIntents: "+checks+" checks passed");
    }
}
