package kr.offline.hwp;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Metadata-only opaque handles; stable identities and a hard bound, never active-handle eviction. */
final class NativeHandleRegistry<T> {
    static final int MAX_HANDLES=1024;
    private final String prefix;
    private final Map<String,T> values=new HashMap<>();
    private final Map<String,String> identities=new HashMap<>();
    NativeHandleRegistry(String prefix){this.prefix=prefix;}
    synchronized String register(String identity,T value)throws IOException {
        String id=identities.get(identity);
        if(id!=null){values.put(id,value);return id;}
        id=create(value);identities.put(identity,id);return id;
    }
    synchronized String create(T value)throws IOException {
        if(values.size()>=MAX_HANDLES)throw new IOException("이 세션의 파일 연결 한도(1024개)에 도달했어요. 편집한 문서를 저장한 뒤 앱을 다시 열어 주세요.");
        String id=prefix+UUID.randomUUID();values.put(id,value);return id;
    }
    synchronized T get(String id){return values.get(id);}
    synchronized boolean containsKey(String id){return values.containsKey(id);}
    synchronized int size(){return values.size();}
    /** Only terminal temporary new-document IDs are removed; selected source handles stay valid. */
    synchronized void remove(String id){values.remove(id);identities.values().removeIf(value->value.equals(id));}
}
