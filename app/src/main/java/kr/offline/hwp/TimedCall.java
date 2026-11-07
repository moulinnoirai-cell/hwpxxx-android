package kr.offline.hwp;

import java.io.IOException;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Runs a blocking provider call on a bounded daemon pool so the caller can always give up.
 * A DocumentsProvider may ignore CancellationSignal or never answer; without this, one hung
 * Binder call would hold the single I/O thread and every later save, release and abort with it.
 * <p>
 * <b>Deadline.</b> When the caller gives up it only marks the call abandoned, interrupts the worker and hands the {@code cancel}
 * callback to a small FIXED pool of helper threads. The caller never runs a callback itself, so a callback that blocks cannot
 * stretch the deadline. If the helpers are all busy (blocked callbacks) the cancel is dropped and counted in
 * {@link #cleanupRejected}: cancel is best effort (the worker is interrupted anyway), never run inline and never given a thread
 * of its own, so threads stay at {@link #MAX_WORKERS} + {@link #CLEANUP_THREADS} however many calls hang.
 * <p>
 * <b>Ownership of a result.</b> A value (a Cursor, stream, file descriptor...) is owned by the provider worker that produced it
 * until the caller has really taken it. The worker publishes the value, then waits (at most {@link #HANDOFF_MS}) until the caller
 * has taken it or given up; if the caller gave up (before or after the value arrived) the worker disposes of the value itself, once.
 * So disposal never depends on the cancel callback or on the cleanup pool: a blocked or saturated cancel cannot strand a value, and
 * the owner is always one of the {@link #MAX_WORKERS} provider workers, which also bounds how many disposals can be pending.
 * A disposer that blocks forever occupies its worker for good, which the capacity limit turns into the "busy" refusal.
 * No Android dependency, so the behaviour is exercised on the JVM.
 */
final class TimedCall {
    static final class Timeout extends IOException { Timeout(String m){super(m);} }
    static final class Cancelled extends IOException { Cancelled(String m){super(m);} }
    /** Provider calls that may be in flight (abandoned ones included) and helper threads for cancel callbacks. */
    static final int MAX_WORKERS=8,CLEANUP_THREADS=2,CLEANUP_QUEUE=16;
    /** How long a worker keeps a delivered value for a caller that has not yet taken it (the caller polls every 40 ms). */
    static final long HANDOFF_MS=2000;
    /** Cancel callbacks that were dropped because every helper was blocked and the queue was full (diagnostics and tests). */
    static final AtomicInteger cleanupRejected=new AtomicInteger();
    private static final ExecutorService POOL=new ThreadPoolExecutor(0,MAX_WORKERS,30,TimeUnit.SECONDS,new SynchronousQueue<Runnable>(),r->{Thread t=new Thread(r,"provider-call");t.setDaemon(true);return t;});
    private static final ThreadPoolExecutor CLEANUP=newCleanupPool();
    private static ThreadPoolExecutor newCleanupPool(){
        ThreadPoolExecutor pool=new ThreadPoolExecutor(CLEANUP_THREADS,CLEANUP_THREADS,10,TimeUnit.SECONDS,new ArrayBlockingQueue<Runnable>(CLEANUP_QUEUE),r->{Thread t=new Thread(r,"provider-cleanup");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
        pool.allowCoreThreadTimeOut(true);return pool;
    }
    private static final int RUNNING=0,DELIVERED=1,TAKEN=2,ABANDONED=3;
    private TimedCall(){}

    /** One call: the outcome the worker publishes and the state both sides agree on. */
    private static final class Call<T> {
        final AtomicInteger state=new AtomicInteger(RUNNING);
        final CountDownLatch done=new CountDownLatch(1),resolved=new CountDownLatch(1);
        final AtomicBoolean disposed=new AtomicBoolean();
        volatile T value;volatile Throwable error;
        /** The caller's one attempt to take the outcome. A worker that lost patience (HANDOFF_MS) has abandoned it. */
        T take()throws Exception {
            if(!state.compareAndSet(DELIVERED,TAKEN))throw new Timeout("Termux가 제한 시간 안에 응답하지 않았어요.");
            resolved.countDown();
            Throwable failure=error;
            if(failure==null)return value;
            if(failure instanceof Exception)throw (Exception)failure;
            if(failure instanceof Error)throw (Error)failure;
            throw new IOException(failure);
        }
        void dispose(Consumer<T> discard){
            T v=value;
            if(v==null||discard==null||!disposed.compareAndSet(false,true))return;
            try{discard.accept(v);}catch(RuntimeException ignored){}
        }
    }

    /**
     * @param cancel  called once, on a helper thread, when the caller gives up (close a stream, cancel a CancellationSignal); may be null
     * @param discard receives a value the caller never took, on the provider worker that produced it, exactly once; may be null
     */
    static <T> T call(Callable<T> body,AtomicBoolean stop,long timeoutMs,Runnable cancel,Consumer<T> discard)throws Exception {
        return call(body,stop,timeoutMs,cancel,discard,null);
    }
    /** @param afterDelivered test seam: runs on the worker right after it published its outcome, before the caller is told */
    static <T> T call(Callable<T> body,AtomicBoolean stop,long timeoutMs,Runnable cancel,Consumer<T> discard,Runnable afterDelivered)throws Exception {
        final Call<T> call=new Call<>();
        final Future<?> future;
        try {
            future=POOL.submit(()->work(call,body,discard,afterDelivered));
        } catch(RejectedExecutionException busy){throw new IOException("앱이 이전 요청을 기다리고 있어요. 잠시 뒤 다시 시도해 주세요.",busy);}
        final long end=System.nanoTime()+timeoutMs*1_000_000L;
        while(true) {
            try {
                if(call.done.await(40,TimeUnit.MILLISECONDS))return call.take();
                if(stop!=null&&stop.get()){giveUp(call,future,cancel);throw new Cancelled("작업을 취소했어요.");}
                if(System.nanoTime()-end>=0){giveUp(call,future,cancel);throw new Timeout("Termux가 제한 시간 안에 응답하지 않았어요.");}
            }
            catch(InterruptedException interrupted){giveUp(call,future,cancel);Thread.currentThread().interrupt();throw new Cancelled("작업을 취소했어요.");}
        }
    }
    /** Runs on the provider worker; it stays the owner of a delivered value until the caller took it or gave up. */
    private static <T> void work(Call<T> call,Callable<T> body,Consumer<T> discard,Runnable afterDelivered){
        T result=null;Throwable failure=null;
        try{result=body.call();}catch(Throwable t){failure=t;}
        call.value=result;call.error=failure;
        if(!call.state.compareAndSet(RUNNING,DELIVERED)){call.dispose(discard);return;}   // the caller gave up first: nobody will take it
        if(afterDelivered!=null)afterDelivered.run();
        call.done.countDown();
        if(result==null||discard==null)return;                                              // nothing that needs closing: the caller may take it whenever
        final long end=System.nanoTime()+HANDOFF_MS*1_000_000L;
        while(call.state.get()==DELIVERED){
            long left=end-System.nanoTime();
            if(left<=0){call.state.compareAndSet(DELIVERED,ABANDONED);break;}                // the caller vanished without resolving: abandon, then dispose
            try{call.resolved.await(left,TimeUnit.NANOSECONDS);}catch(InterruptedException giveUpInterrupt){/* the state decides, re-checked above */}
        }
        if(call.state.get()==ABANDONED)call.dispose(discard);
    }
    private static <T> void giveUp(Call<T> call,Future<?> future,Runnable cancel) {
        // RUNNING -> ABANDONED: the worker disposes of its late value when the body returns. DELIVERED -> ABANDONED: the worker is
        // waiting with the value and disposes of it now. TAKEN (taken a moment ago): nothing to do.
        if(!call.state.compareAndSet(RUNNING,ABANDONED))call.state.compareAndSet(DELIVERED,ABANDONED);
        call.resolved.countDown();
        future.cancel(true);   // interrupts the worker; never blocks
        if(cancel==null)return;
        // Best effort and never inline: a cancel that blocks must not hold the caller, and nothing depends on it running (see the class comment).
        try{CLEANUP.execute(()->{try{cancel.run();}catch(RuntimeException ignored){}});}
        catch(RejectedExecutionException busy){cleanupRejected.incrementAndGet();}
    }
    /** Helper threads that currently exist (tests: never more than {@link #CLEANUP_THREADS}). */
    static int cleanupThreads(){return CLEANUP.getPoolSize();}
}
