package kr.offline.hwp;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;

/** Activity-owned capabilities. Session identity is distinct from the persistent tab UUID. */
public final class WorkspaceRequests {
    public static final int MAX_PICKER_CODE=1_000_000_000;
    public static final long CLOSE_TIMEOUT_MS=120_000;
    public interface Clock {long nowMillis();}
    public static final class Picker {
        public final String tabId, sessionId;
        public final int localCode;
        private Picker(String tabId,String sessionId,int localCode){this.tabId=tabId;this.sessionId=sessionId;this.localCode=localCode;}
    }
    private static final class Close {
        final String tabId,sessionId;final long createdAt;
        Close(String tabId,String sessionId,long createdAt){this.tabId=tabId;this.sessionId=sessionId;this.createdAt=createdAt;}
    }
    private final Map<Integer,Picker> pickers=new HashMap<>();
    private final Map<String,Close> closes=new HashMap<>();
    private int nextPickerCode;
    private final Clock clock;
    public WorkspaceRequests(){this(1000);}
    public WorkspaceRequests(int nextPickerCode){this(nextPickerCode,()->System.nanoTime()/1_000_000L);}
    /** Deterministic monotonic-clock seam; production never uses wall-clock time for consent expiry. */
    public WorkspaceRequests(int nextPickerCode,Clock clock){if(clock==null)throw new IllegalArgumentException("Missing clock");this.clock=clock;this.nextPickerCode=Math.max(1000,nextPickerCode);}
    public synchronized int nextPickerCode(){return nextPickerCode;}
    /** A durable process-wide high-water mark may only advance this Activity's allocator. */
    public synchronized void raiseNextPickerCodeTo(int floor){if(floor>nextPickerCode)nextPickerCode=floor;}
    public synchronized int registerPicker(String tabId,String sessionId,int localCode){
        requireIdentity(tabId,sessionId);
        // Never reuse a request code during this Activity's lifetime, even after cancellation.
        if(nextPickerCode>MAX_PICKER_CODE)throw new IllegalStateException("파일 선택 요청 한도에 도달했어요. 열린 문서는 계속 편집하고 저장할 수 있어요.");
        int code=nextPickerCode++;pickers.put(code,new Picker(tabId,sessionId,localCode));return code;
    }
    public synchronized Picker consumePicker(int code){return pickers.remove(code);}
    public synchronized String requestClose(String tabId,String sessionId){
        requireIdentity(tabId,sessionId);expireCloses();
        for(Map.Entry<String,Close> entry:closes.entrySet())if(entry.getValue().sessionId.equals(sessionId))return entry.getKey();
        String token=UUID.randomUUID().toString();closes.put(token,new Close(tabId,sessionId,clock.nowMillis()));return token;
    }
    /** A wrong session cannot consume another session's close capability. */
    public synchronized String consumeClose(String sessionId,String token){
        expireCloses();Close close=closes.get(token);if(close==null||!close.sessionId.equals(sessionId))return null;
        closes.remove(token);return close.tabId;
    }
    public synchronized boolean hasPendingClose(String sessionId){expireCloses();for(Close close:closes.values())if(close.sessionId.equals(sessionId))return true;return false;}
    public synchronized boolean isPendingClose(String sessionId,String token){expireCloses();Close close=closes.get(token);return close!=null&&close.sessionId.equals(sessionId);}
    private void expireCloses(){long now=clock.nowMillis();for(Iterator<Close> i=closes.values().iterator();i.hasNext();){long age=now-i.next().createdAt;if(age<0||age>=CLOSE_TIMEOUT_MS)i.remove();}}
    public synchronized void removeSession(String sessionId){
        for(Iterator<Picker> i=pickers.values().iterator();i.hasNext();)if(i.next().sessionId.equals(sessionId))i.remove();
        for(Iterator<Close> i=closes.values().iterator();i.hasNext();)if(i.next().sessionId.equals(sessionId))i.remove();
    }
    private static void requireIdentity(String tabId,String sessionId){if(tabId==null||tabId.isEmpty()||sessionId==null||sessionId.isEmpty())throw new IllegalArgumentException("Missing session identity");}
}
