package kr.offline.hwp;

import java.io.File;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Breadth-first traversal of a DocumentsProvider tree with hard limits. No Android dependency.
 * <ul>
 * <li>Cycles are cut by directory id. A provider reports no canonical identity, so a symlink such as {@code loop -> ..}
 *     (a new id for a folder that is already being walked) can only be recognised by what it lists. Equal listings alone prove
 *     nothing (an extracted archive can nest identical layouts), so a folder that lists exactly what one of its ancestors lists
 *     is entered unless the folders below both still look identical for {@link #VERIFY_DEPTH} levels. Even then the folder is
 *     only <em>skipped on evidence</em>: it counts as skipped, the walk is not {@link #complete()} and no document reference is
 *     forgotten because of it. The work spent on this is bounded ({@link #MAX_VERIFY_QUERIES}); beyond it the folder is skipped
 *     and counted the same way.</li>
 * <li>Dot-folders, {@code node_modules}, {@code __pycache__} and caller-named top-level folders (Termux's
 *     {@code ~/storage} symlinks to shared storage) are never entered.</li>
 * <li>A directory at the depth limit still yields its own documents; deeper folders are counted as skipped, they do not
 *     abort the walk. The {@code limited} flag is reserved for the document, entry, folder, queue and time budgets.</li>
 * <li>Every tree gets a quota of the document budget, so one large tree cannot starve the trees after it. Reaching the quota (or
 *     any other per-tree limit) makes the pass incomplete ({@link #limited}) but does not stop the trees after it: only a
 *     global stop does ({@link #finished()}: cancellation or the wall-clock budget).</li>
 * <li>A failing or timed-out directory is counted instead of aborting.</li>
 * </ul>
 */
final class TermuxWalker {
    static final int MAX_FOLDERS=50000,MAX_ENTRIES=150000,MAX_DEPTH=64,MAX_PENDING=50000;
    /** How many levels below a suspected alias and its twin must list identically before the folder is treated as an alias. */
    static final int VERIFY_DEPTH=3;
    /** Extra provider listings the whole pass may spend confirming suspected aliases; every tree gets a fair share of what is left. */
    static final int MAX_VERIFY_QUERIES=240;
    /** A confirmation listing is read only this far; a longer folder cannot be compared completely, so the suspect is undecidable (skipped). */
    static final int VERIFY_MAX_ENTRIES=2000;
    /** Provider documents/folders are reported to the UI this often. */
    static final int PROGRESS_EVERY=25;
    static final class Entry {
        final String id,name;final boolean directory;final long size,modified;
        Entry(String id,String name,boolean directory,long size,long modified){this.id=id;this.name=name;this.directory=directory;this.size=size;this.modified=modified;}
    }
    interface Source {
        List<Entry> list(String directoryId,int maxEntries)throws Exception;
        /** Same, but the answer is worth nothing after {@code budgetMs} (what is left of the pass's wall clock): a provider-backed source
         *  clamps its own timeout to it. The default ignores the budget. */
        default List<Entry> list(String directoryId,int maxEntries,long budgetMs)throws Exception {return list(directoryId,maxEntries);}
    }
    interface Visitor {void document(Entry entry,String folderPath,String format)throws Exception;}
    interface Progress {void folders(int folders,int documents);}
    /** One linked tree of a multi-tree pass. {@code visitor} receives only this tree's documents. */
    static final class Root {
        final String id,label;final Source source;final Visitor visitor;final Set<String> skipTopLevel;final boolean granted;
        Root(String id,String label,Source source,Visitor visitor,Set<String> skipTopLevel,boolean granted){this.id=id;this.label=label;this.source=source;this.visitor=visitor;this.skipTopLevel=skipTopLevel;this.granted=granted;}
    }
    private static final class Dir {
        final String id,path;final int depth;final Dir parent;String fingerprint;List<Entry> folders=Collections.emptyList();
        Dir(String id,String path,int depth,Dir parent){this.id=id;this.path=path;this.depth=depth;this.parent=parent;}
    }

    private final int documentBudget;
    private final AtomicBoolean stop;
    private final long deadline;
    private final Set<String> seenDocuments=new HashSet<>();
    /** After this many directories in a row time out, the provider is considered unresponsive and the tree is abandoned.
     *  Ordinary failures (an unreadable folder) are counted but never abort the walk. */
    static final int MAX_CONSECUTIVE_FAILURES=3;
    /** aliases: confirmed by evidence; undecided: suspects that could not be confirmed (error, cancel, time, budget, truncated listing).
     *  Both are skipped (counted in {@code skipped}); neither makes the pass complete. */
    int count,folders,skipped,aliases,undecided,entries,verifyQueries;
    /** Verification listings this tree may still ask for / verification timeouts seen / entries read by verification since the last accounting. */
    private int verifyLimit=MAX_VERIFY_QUERIES,verifyTimeouts,verifyEntriesUnbooked;
    /** The pass is incomplete: a per-tree or global limit was reached. It does not stop the other trees; see {@link #finished()}. */
    boolean limited;
    private boolean timedOut;
    Progress progress;

    TermuxWalker(int documentBudget,AtomicBoolean stop){this(documentBudget,stop,Long.MAX_VALUE/4_000_000L);}
    /** @param timeBudgetMs wall-clock budget of the whole walk; running out of it ends the walk with {@code limited} */
    TermuxWalker(int documentBudget,AtomicBoolean stop,long timeBudgetMs){this.documentBudget=documentBudget;this.stop=stop;this.deadline=System.nanoTime()+Math.min(timeBudgetMs,Long.MAX_VALUE/4_000_000L)*1_000_000L;}
    /** A GLOBAL stop: the user cancelled or the wall-clock budget of the whole pass is used up. Nothing after this point is walked.
     *  A tree that merely ran into its own quota or folder/entry cap is not "finished": the trees after it must still be walked. */
    boolean finished(){return stop.get()||timeUp();}
    private boolean timeUp(){if(!timedOut&&System.nanoTime()-deadline>=0)timedOut=true;return timedOut;}
    /** True when every reachable folder was listed: only then may the caller forget documents it did not see again. */
    boolean complete(){return !limited&&skipped==0&&!stop.get()&&!timedOut;}
    int remainingBudget(){return Math.max(0,documentBudget-count);}

    /** What one of {@code treesLeft} trees may take from {@code remaining} documents; unused share flows to the trees after it. */
    static int fairShare(int remaining,int treesLeft){return Math.max(1,remaining/Math.max(1,treesLeft));}
    static boolean skipDirectory(String name){return name.startsWith(".")||name.equals("node_modules")||name.equals("__pycache__");}

    /** Same names, kinds, sizes and times. Equal fingerprints make a folder SUSPECT of being an alias; they are not proof. */
    static String fingerprint(List<Entry> children){
        if(children.isEmpty())return null;
        List<String> lines=new ArrayList<>(children.size());
        for(Entry e:children)lines.add((e.directory?"d|":"f|")+e.name+"|"+e.size+"|"+e.modified);
        Collections.sort(lines);return String.join("\n",lines);
    }

    /**
     * The multi-tree pass the app runs: each tree gets a fair share of what is left, and a tree that stops early (its quota, a
     * folder/entry cap) only makes the pass incomplete. Only {@link #finished()} ends the loop; trees that were not reached
     * because of it also make the pass incomplete.
     */
    void walkAll(List<Root> roots)throws Exception {
        for(int i=0;i<roots.size();i++){
            if(finished()){limited=true;break;}
            Root root=roots.get(i);
            if(!root.granted){skipped++;continue;}
            // A tree that is full of suspected aliases must not use up the confirmation work the trees after it need.
            verifyLimit=verifyQueries+Math.max(0,(MAX_VERIFY_QUERIES-verifyQueries)/(roots.size()-i));
            walk(root.id,root.label,root.source,root.visitor,fairShare(remainingBudget(),roots.size()-i),root.skipTopLevel);
        }
    }

    /** Whole budget for one tree. */
    void walk(String rootId,String label,Source source,Visitor visitor)throws Exception {walk(rootId,label,source,visitor,Integer.MAX_VALUE,Collections.<String>emptySet());}

    /**
     * @param quota        most documents this tree may add (its fair share of the budget)
     * @param skipTopLevel names of folders directly under the root that are never entered
     */
    void walk(String rootId,String label,Source source,Visitor visitor,int quota,Set<String> skipTopLevel)throws Exception {
        ArrayDeque<Dir> pending=new ArrayDeque<>();Set<String> seen=new HashSet<>();pending.add(new Dir(rootId,label,0,null));
        int failures=0,treeFolders=0,treeEntries=0,treeCount=0;final int limit=Math.min(quota,remainingBudget());
        // Nothing left to give this tree: it may hold documents, so the pass is incomplete (and the tree costs no queries).
        if(limit<=0){limited=true;return;}
        while(!pending.isEmpty()&&!stop.get()) {
            if(timeUp()){limited=true;break;}
            Dir dir=pending.removeFirst();if(!seen.add(dir.id))continue;
            if(++treeFolders>MAX_FOLDERS){limited=true;break;}
            final int room=MAX_ENTRIES-treeEntries;
            if(room<=0){limited=true;break;}
            folders++;if(progress!=null&&folders%PROGRESS_EVERY==0)progress.folders(folders,count);
            List<Entry> children;
            try{children=source.list(dir.id,room,msLeft());}
            catch(Exception e){if(stop.get())break;skipped++;failures=e instanceof TimedCall.Timeout?failures+1:0;if(failures>=MAX_CONSECUTIVE_FAILURES){skipped+=pending.size();break;}continue;}
            if(children==null){skipped++;failures=0;continue;}
            failures=0;
            dir.fingerprint=fingerprint(children);
            List<Entry> subfolders=new ArrayList<>();for(Entry e:children)if(e.directory&&e.id!=null&&e.name!=null)subfolders.add(e);dir.folders=subfolders;
            if(dir.fingerprint!=null){
                Dir twin=null;for(Dir a=dir.parent;a!=null&&twin==null;a=a.parent)if(dir.fingerprint.equals(a.fingerprint))twin=a;
                // Suspect: it lists exactly what an ancestor lists. Enter it unless the folders below still look identical.
                if(twin!=null){
                    Boolean alias=aliasOf(dir,twin,source,skipTopLevel);
                    // What the confirmation read counts against this tree's entry budget (and the pass's total) like any other listing.
                    treeEntries+=verifyEntriesUnbooked;entries+=verifyEntriesUnbooked;verifyEntriesUnbooked=0;
                    if(!Boolean.FALSE.equals(alias)){if(alias==null)undecided++;else aliases++;skipped++;children=Collections.emptyList();}
                }
            }
            // The source stops reading at the room it was given, so a full page may hide more entries.
            if(children.size()>=room)limited=true;
            for(Entry e:children) {
                if(stop.get())return;
                if(++treeEntries>MAX_ENTRIES){limited=true;break;}
                entries++;
                if(e.id==null||e.name==null)continue;
                if(e.directory) {
                    if(skipDirectory(e.name)||(dir.depth==0&&skipTopLevel.contains(e.name)))continue;
                    if(dir.depth>=MAX_DEPTH){skipped++;continue;}
                    if(pending.size()>=MAX_PENDING){limited=true;continue;}
                    pending.addLast(new Dir(e.id,dir.path+"/"+e.name,dir.depth+1,dir));continue;
                }
                String format=FileStore.ext(new File(e.name));
                if((!format.equals("hwp")&&!format.equals("hwpx"))||!seenDocuments.add(e.id))continue;
                if(treeCount>=limit){limited=true;pending.clear();break;}
                count++;treeCount++;visitor.document(e,dir.path,format);
            }
        }
    }

    private long msLeft(){return Math.max(1L,(deadline-System.nanoTime())/1_000_000L);}
    /** One confirmation listing: bounded in time (what is left of the pass, never past it), in number (the tree's share of
     *  {@link #MAX_VERIFY_QUERIES}, no more after {@link #MAX_CONSECUTIVE_FAILURES} timeouts) and in size (a truncated listing proves nothing). */
    private List<Entry> listForVerification(String id,Source source)throws Exception {
        if(stop.get()||timeUp()||verifyQueries>=verifyLimit||verifyTimeouts>=MAX_CONSECUTIVE_FAILURES)throw new IllegalStateException("verification budget");
        verifyQueries++;
        List<Entry> listing;
        try{listing=source.list(id,VERIFY_MAX_ENTRIES,msLeft());}
        catch(TimedCall.Timeout slow){verifyTimeouts++;throw slow;}
        if(listing==null)throw new IllegalStateException("no listing");
        verifyEntriesUnbooked+=listing.size();
        if(listing.size()>=VERIFY_MAX_ENTRIES)throw new IllegalStateException("listing too long to compare");
        return listing;
    }
    /**
     * Do the folders below {@code dir} and below {@code twin} (an ancestor that lists the same) keep matching for
     * {@link #VERIFY_DEPTH} levels (or until the chain ends), following the first folder at every level? A real alias of an ancestor does so forever, a
     * folder that merely has the same layout ends up different.
     * @return TRUE when they keep matching (treat as alias), FALSE when they differ (a real, distinct folder: enter it),
     *         null when this could not be decided (provider error, cancellation, verification budget): skipped, never guessed
     */
    private Boolean aliasOf(Dir dir,Dir twin,Source source,Set<String> skipTopLevel) {
        List<Entry> mine=dir.folders,theirs=twin.folders;
        try {
            for(int level=0;level<VERIFY_DEPTH;level++){
                Entry next=firstFolder(mine,skipTopLevel);
                // An alias of an ancestor always lists the way back down, so at the first level a folder without subfolders is no alias.
                // Deeper, the chain simply ended: every level up to its end matched.
                if(next==null)return level==0?Boolean.FALSE:Boolean.TRUE;
                Entry counterpart=null;for(Entry e:theirs)if(e.name.equals(next.name)){counterpart=e;break;}
                if(counterpart==null)return Boolean.FALSE;
                if(next.id.equals(counterpart.id))return Boolean.TRUE;                           // the very same folder reached again: provably an alias
                List<Entry> a=listForVerification(next.id,source),b=listForVerification(counterpart.id,source);
                if(!Objects.equals(fingerprint(a),fingerprint(b)))return Boolean.FALSE;
                mine=foldersOf(a);theirs=foldersOf(b);
            }
            return Boolean.TRUE;
        } catch(Exception undecided){return null;}
    }
    private static List<Entry> foldersOf(List<Entry> listing){List<Entry> out=new ArrayList<>();for(Entry e:listing)if(e.directory&&e.id!=null&&e.name!=null)out.add(e);return out;}
    private static Entry firstFolder(List<Entry> folders,Set<String> skipTopLevel){
        Entry best=null;for(Entry e:folders){if(skipDirectory(e.name)||skipTopLevel.contains(e.name))continue;if(best==null||e.name.compareTo(best.name)<0)best=e;}
        return best;
    }
}
