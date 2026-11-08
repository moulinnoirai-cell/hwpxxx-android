package kr.offline.hwp;

import java.util.function.Consumer;

/** Serial native upload ownership. Stale aborts never affect a different token or kind. */
final class NativeSessions<T extends NativeSessions.Session> {
    static class Session {String token,sourceId;String kind="document";}
    T upload,draft,state;
    private static boolean matches(Session session,String token){return session!=null&&token!=null&&!token.isEmpty()&&token.equals(session.token);}
    void abort(String token,Consumer<T> discarded){
        T first=matches(upload,token)?upload:null,second=matches(draft,token)?draft:null,third=matches(state,token)?state:null;
        if(first!=null)upload=null;if(second!=null)draft=null;if(third!=null)state=null;
        if(first!=null)discarded.accept(first);if(second!=null)discarded.accept(second);if(third!=null)discarded.accept(third);
    }
    /** null token retains legacy abortPdf semantics, but only the PDF page slot is cleared. */
    boolean abortPdf(String token){
        if(token!=null&&!token.isEmpty()&&(!matches(upload,token)||!"pdf".equals(upload.kind)))return false;
        if(upload!=null&&"pdf".equals(upload.kind))upload=null;
        return true;
    }
    boolean referencesSource(String sourceId){return sourceId!=null&&((upload!=null&&sourceId.equals(upload.sourceId))||(draft!=null&&sourceId.equals(draft.sourceId))||(state!=null&&sourceId.equals(state.sourceId)));}
    void clear(Consumer<T> discarded){T first=upload,second=draft,third=state;upload=null;draft=null;state=null;if(first!=null)discarded.accept(first);if(second!=null)discarded.accept(second);if(third!=null)discarded.accept(third);}
}
