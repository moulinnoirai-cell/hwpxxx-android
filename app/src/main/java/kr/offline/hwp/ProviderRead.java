package kr.offline.hwp;

import java.io.IOException;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/** Bounded foreign-provider reads. Bodies return detached data; only the caller commits app state. */
final class ProviderRead {
    static final long TIMEOUT_MS=25000;
    interface Reader<T> {T read(Resources resources)throws Exception;}
    private ProviderRead(){}
    static <T> T read(Reader<T> reader)throws Exception {return read(reader,TIMEOUT_MS);}
    static <T> T read(Reader<T> reader,long timeoutMs)throws Exception {
        Resources resources=new Resources();
        try {
            return TimedCall.call(()->{try(Resources owned=resources){return reader.read(owned);}},null,timeoutMs,resources::close,null);
        }catch(TimedCall.Timeout timeout){throw new IOException("파일 제공자가 제한 시간 안에 응답하지 않았어요. 잠시 뒤 다시 시도해 주세요.",timeout);}
    }
    /** Every acquired cursor/stream is closed once, including acquisitions that arrive after cancellation. */
    static final class Resources implements AutoCloseable {
        private static final class Entry {final AutoCloseable resource;final AtomicBoolean closed=new AtomicBoolean();Entry(AutoCloseable resource){this.resource=resource;}void close(){if(closed.compareAndSet(false,true))try{resource.close();}catch(Exception ignored){}}}
        private final AtomicBoolean closed=new AtomicBoolean();
        private final ConcurrentLinkedQueue<Entry> entries=new ConcurrentLinkedQueue<>();
        <T extends AutoCloseable> T own(T resource)throws IOException {
            if(resource==null)return null;
            Entry entry=new Entry(resource);entries.add(entry);
            if(closed.get()){entries.remove(entry);entry.close();throw new IOException("파일 읽기를 취소했어요.");}
            return resource;
        }
        @Override public void close(){closed.set(true);Entry entry;while((entry=entries.poll())!=null)entry.close();}
    }
}
