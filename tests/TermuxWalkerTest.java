package kr.offline.hwp;

import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** JVM tests for the provider traversal and the abandonable provider call (no Android needed). */
public class TermuxWalkerTest {
    static int checks=0;
    static void yes(boolean b,String what){if(!b)throw new AssertionError(what);checks++;}
    interface Run {void run()throws Exception;}
    static <E extends Throwable> void thrown(Class<E> type,Run r,String what)throws Exception{try{r.run();}catch(Throwable t){if(type.isInstance(t)){checks++;return;}throw new AssertionError(what+": unexpected "+t,t);}throw new AssertionError(what+": nothing thrown");}
    static TermuxWalker.Entry dir(String id,String name){return new TermuxWalker.Entry(id,name,true,0,0);}
    static TermuxWalker.Entry file(String id,String name){return new TermuxWalker.Entry(id,name,false,10,1);}
    /** A map-backed fake provider; ids are paths. */
    static class Fake implements TermuxWalker.Source {
        final Map<String,List<TermuxWalker.Entry>> tree=new HashMap<>();final List<String> listed=new ArrayList<>();Set<String> failing=new HashSet<>(),hanging=new HashSet<>();
        public List<TermuxWalker.Entry> list(String id,int max)throws Exception{
            listed.add(id);
            if(failing.contains(id))throw new IOException("provider error");
            if(hanging.contains(id))throw new TimedCall.Timeout("slow");
            List<TermuxWalker.Entry> all=tree.getOrDefault(id,Collections.<TermuxWalker.Entry>emptyList());return all.size()>max?new ArrayList<>(all.subList(0,max)):all;
        }
    }
    /** A provider that makes up its tree from a canonical path: ids are paths, a symlink is a path that resolves to another one. */
    static class Generated implements TermuxWalker.Source {
        final Map<String,List<TermuxWalker.Entry>> tree=new HashMap<>();final java.util.function.Function<String,String> canonical;String failOn;
        Generated(java.util.function.Function<String,String> canonical){this.canonical=canonical;}
        public List<TermuxWalker.Entry> list(String id,int max)throws Exception{
            if(failOn!=null&&id.contains(failOn))throw new IOException("provider error");
            List<TermuxWalker.Entry> base=tree.getOrDefault(canonical.apply(id),Collections.<TermuxWalker.Entry>emptyList());
            List<TermuxWalker.Entry> out=new ArrayList<>();for(TermuxWalker.Entry e:base)out.add(new TermuxWalker.Entry(id+"/"+e.name,e.name,e.directory,e.size,e.modified));
            return out.size()>max?new ArrayList<>(out.subList(0,max)):out;
        }
    }
    static List<String> walk(TermuxWalker w,Fake f)throws Exception{List<String> found=new ArrayList<>();w.walk("root","Termux · home",f,(e,folder,format)->found.add(folder+"/"+e.name));return found;}
    public static void main(String[] args)throws Exception {
        // Nested folders, mixed case extensions, non-documents, .git excluded.
        Fake f=new Fake();
        f.tree.put("root",Arrays.asList(file("r1","루트.hwp"),file("r2","readme.md"),dir("d1","프로젝트"),dir("g",".git"),dir("d2","빈 폴더")));
        f.tree.put("d1",Arrays.asList(file("a","보고서.HWPX"),dir("d3","하위"),file("b","그림.png")));
        f.tree.put("d3",Arrays.asList(file("c","깊은 문서.hwp")));
        f.tree.put("g",Arrays.asList(file("secret","비밀.hwp")));
        TermuxWalker w=new TermuxWalker(100,new AtomicBoolean());List<String> found=walk(w,f);
        yes(found.size()==3&&found.contains("Termux · home/루트.hwp")&&found.contains("Termux · home/프로젝트/보고서.HWPX")&&found.contains("Termux · home/프로젝트/하위/깊은 문서.hwp"),"nested search "+found);
        yes(!f.listed.contains("g")&&!w.limited&&w.skipped==0&&w.folders==4,"git folder is never entered");
        // Cycles (a folder that lists an ancestor again) and a document reachable twice are reported once.
        Fake cyc=new Fake();cyc.tree.put("root",Arrays.asList(dir("x","x"),file("same","같은.hwp")));cyc.tree.put("x",Arrays.asList(dir("root","back"),dir("x","self"),file("same","같은.hwp")));
        w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,cyc);yes(found.size()==1&&w.folders==2&&!w.limited,"cycle and duplicate document "+found+" "+w.folders);
        // Depth: a chain deeper than the limit never aborts the walk: the folders below the limit are counted as skipped
        // (not as a budget limit) and the documents of every folder up to the limit are still returned.
        Fake deep=new Fake();for(int i=0;i<=TermuxWalker.MAX_DEPTH+3;i++){String id=i==0?"root":"n"+i,next="n"+(i+1);deep.tree.put(id,new ArrayList<>(Arrays.asList(dir(next,"d"+i),file("f"+i,"f"+i+".hwp"))));}
        w=new TermuxWalker(1000,new AtomicBoolean());found=walk(w,deep);yes(!w.limited&&w.skipped==1&&found.size()==TermuxWalker.MAX_DEPTH+1,"depth overflow is a skipped branch, not a limit: found "+found.size()+" skipped "+w.skipped+" limited "+w.limited);
        yes(!w.complete(),"a pass that skipped a branch is not complete (references to unseen documents are kept)");
        // A deep branch does not hide the shallower siblings that come after it, in the same tree or in the next one.
        Fake after=new Fake();after.tree.putAll(deep.tree);after.tree.put("root",new ArrayList<>(Arrays.asList(dir("n1","a-deep"),dir("z","z-sibling"))));after.tree.put("z",Arrays.asList(file("zf","형제.hwp")));
        w=new TermuxWalker(1000,new AtomicBoolean());found=walk(w,after);yes(found.contains("Termux · home/z-sibling/형제.hwp"),"sibling after a deep branch is found");
        // Document budget stops the walk and reports it.
        Fake many=new Fake();List<TermuxWalker.Entry> docs=new ArrayList<>();for(int i=0;i<50;i++)docs.add(file("m"+i,"m"+i+".hwp"));many.tree.put("root",docs);
        w=new TermuxWalker(7,new AtomicBoolean());found=walk(w,many);yes(found.size()==7&&w.limited,"document budget");
        // Cancellation mid-walk.
        AtomicBoolean stop=new AtomicBoolean();Fake slow=new Fake(){public List<TermuxWalker.Entry> list(String id,int max)throws Exception{if(id.equals("d1"))stop.set(true);return super.list(id,max);}};slow.tree.putAll(f.tree);
        w=new TermuxWalker(100,stop);found=walk(w,slow);yes(w.finished()&&!found.contains("Termux · home/프로젝트/하위/깊은 문서.hwp"),"cancel stops traversal");
        // One failing folder is skipped; its siblings are still searched.
        Fake broken=new Fake();broken.tree.putAll(f.tree);broken.failing.add("d1");w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,broken);yes(found.size()==1&&w.skipped==1&&!w.limited,"unreadable folder is skipped "+found);
        // A provider that times out repeatedly is abandoned instead of waiting once per folder.
        Fake dead=new Fake();List<TermuxWalker.Entry> top=new ArrayList<>();for(int i=0;i<20;i++){top.add(dir("t"+i,"t"+i));dead.hanging.add("t"+i);}dead.tree.put("root",top);
        w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,dead);yes(dead.listed.size()==1+TermuxWalker.MAX_CONSECUTIVE_FAILURES&&w.skipped==20,"stalled provider abandoned after "+dead.listed.size()+" calls, skipped "+w.skipped);
        // Entry budget bounds a huge folder.
        Fake huge=new Fake();List<TermuxWalker.Entry> big=new ArrayList<>();for(int i=0;i<TermuxWalker.MAX_ENTRIES+10;i++)big.add(file("h"+i,"x"+i+".txt"));huge.tree.put("root",big);
        w=new TermuxWalker(100,new AtomicBoolean());walk(w,huge);yes(w.limited&&w.count==0,"entry limit");

        // ---- H1: symlink loops, aliases and folders that must not be walked ----
        // `loop -> ..` lists exactly what its parent lists; it is detected after one listing and none of its documents are reported twice.
        Fake link=new Fake();
        List<TermuxWalker.Entry> proj=Arrays.asList(file("p/a","a.hwp"),dir("p/sub","sub"),dir("p/loop","loop"));
        link.tree.put("root",Arrays.asList(dir("p","p")));
        link.tree.put("p",proj);link.tree.put("p/loop",proj);                       // the symlink resolves to the parent: identical listing, different ids
        link.tree.put("p/sub",Arrays.asList(file("p/sub/b","b.hwpx"),dir("p/sub/up","up")));
        link.tree.put("p/sub/up",Arrays.asList(file("p/sub/b","b.hwpx"),dir("p/sub/up","up")));   // `up -> .` (lists itself)
        w=new TermuxWalker(1000,new AtomicBoolean());found=walk(w,link);
        yes(found.size()==2&&found.contains("Termux · home/p/a.hwp")&&found.contains("Termux · home/p/sub/b.hwpx"),"loops add no duplicate documents: "+found);
        yes(w.aliases==2&&!w.limited&&w.skipped==2&&w.folders<=6,"loops are cut after one listing each: aliases="+w.aliases+" folders="+w.folders);
        yes(!w.complete(),"a folder skipped as a suspected alias is a guess: the pass is not complete, so no reference is forgotten because of it");
        // Two sibling folders with the same content (a `cp -a` backup) are NOT aliases: both are listed.
        Fake copy=new Fake();copy.tree.put("root",Arrays.asList(dir("x","proj"),dir("y","proj-backup")));
        copy.tree.put("x",Arrays.asList(file("x/d","d.hwp")));copy.tree.put("y",Arrays.asList(file("y/d","d.hwp")));
        w=new TermuxWalker(1000,new AtomicBoolean());found=walk(w,copy);yes(found.size()==2&&w.aliases==0,"identical sibling copies are both reported: "+found);
        // Dot folders, node_modules and the HOME-level ~/storage links are never entered; same names deeper down are not special.
        Fake noisy=new Fake();noisy.tree.put("root",Arrays.asList(dir("c",".cache"),dir("nm","node_modules"),dir("st","storage"),dir("pj","project"),file("rt","루트.hwp"),dir("py","__pycache__"),dir("hid",".hidden-notes")));
        for(String id:new String[]{"c","nm","st","py","hid"})noisy.tree.put(id,Arrays.asList(file(id+"/x","숨김"+id+".hwp")));
        noisy.tree.put("pj",Arrays.asList(file("pj/f","프로젝트.hwp"),dir("pj/st","storage")));noisy.tree.put("pj/st",Arrays.asList(file("pj/st/g","깊은 storage.hwp")));
        List<String> noisyFound=new ArrayList<>();w=new TermuxWalker(1000,new AtomicBoolean());w.walk("root","Termux · home",noisy,(e,folder,format)->noisyFound.add(folder+"/"+e.name),1000,Collections.singleton("storage"));
        Collections.sort(noisyFound);yes(noisyFound.equals(Arrays.asList("Termux · home/project/storage/깊은 storage.hwp","Termux · home/project/프로젝트.hwp","Termux · home/루트.hwp")),"hidden and bulk folders skipped: "+noisyFound);
        yes(!noisy.listed.contains("c")&&!noisy.listed.contains("nm")&&!noisy.listed.contains("st")&&!noisy.listed.contains("hid"),"skipped folders are not even listed");
        // ---- limit fairness: every tree gets a share of the document budget ----
        yes(TermuxWalker.fairShare(10,2)==5&&TermuxWalker.fairShare(3,5)==1&&TermuxWalker.fairShare(0,3)==1&&TermuxWalker.fairShare(9,1)==9,"fair share arithmetic");
        Fake big1=new Fake(),small=new Fake();List<TermuxWalker.Entry> hundred=new ArrayList<>();for(int i=0;i<100;i++)hundred.add(file("b"+i,"big"+i+".hwp"));big1.tree.put("root",hundred);small.tree.put("root",Arrays.asList(file("s1","s1.hwp"),file("s2","s2.hwp"),file("s3","s3.hwp")));
        w=new TermuxWalker(10,new AtomicBoolean());List<String> two=new ArrayList<>();
        w.walk("root","big",big1,(e,folder,format)->two.add(folder+"/"+e.name),TermuxWalker.fairShare(w.remainingBudget(),2),Collections.<String>emptySet());
        w.walk("root","small",small,(e,folder,format)->two.add(folder+"/"+e.name),TermuxWalker.fairShare(w.remainingBudget(),1),Collections.<String>emptySet());
        yes(two.size()==8&&two.stream().filter(x->x.startsWith("small/")).count()==3&&w.limited,"the big tree is cut at its share, the small one is complete: "+two.size());
        Fake third=new Fake();third.tree.put("root",Arrays.asList(file("t1","t1.hwp")));
        w=new TermuxWalker(10,new AtomicBoolean());two.clear();
        for(Fake each:new Fake[]{big1,small,third})w.walk("root","t",each,(e,folder,format)->two.add(folder+"/"+e.name),TermuxWalker.fairShare(w.remainingBudget(),3-(each==big1?0:each==small?1:2)),Collections.<String>emptySet());
        yes(two.stream().anyMatch(x->x.endsWith("/t1.hwp")),"the last tree is still listed after a huge first tree: "+two.size());
        // ---- wall-clock budget and progress ----
        Fake slowTree=new Fake(){public List<TermuxWalker.Entry> list(String id,int max)throws Exception{Thread.sleep(30);return super.list(id,max);}};
        List<TermuxWalker.Entry> kids=new ArrayList<>();for(int i=0;i<200;i++){kids.add(dir("k"+i,"k"+i));slowTree.tree.put("k"+i,Arrays.asList(file("kf"+i,"d"+i+".hwp")));}slowTree.tree.put("root",kids);
        long started=System.nanoTime();w=new TermuxWalker(1000,new AtomicBoolean(),200);found=walk(w,slowTree);
        yes(w.limited&&found.size()<200&&(System.nanoTime()-started)/1_000_000<3000,"time budget ends a slow walk with a partial result: "+found.size());
        List<Integer> ticks=new ArrayList<>();w=new TermuxWalker(1000,new AtomicBoolean());w.progress=(fo,d)->ticks.add(fo);
        Fake wide=new Fake();List<TermuxWalker.Entry> wk=new ArrayList<>();for(int i=0;i<60;i++){wk.add(dir("w"+i,"w"+i));}wide.tree.put("root",wk);walk(w,wide);
        yes(ticks.equals(Arrays.asList(25,50)),"progress is reported every "+TermuxWalker.PROGRESS_EVERY+" folders: "+ticks);


        // ---- F-C: a tree that reaches its own quota must not stop the trees after it (the caller's multi-tree loop, walkAll) ----
        {
            AtomicBoolean never=new AtomicBoolean();
            Fake t0=new Fake(),t1=new Fake();
            t0.tree.put("root",Arrays.asList(file("t0a","a.hwp"),file("t0b","b.hwp"),file("t0c","c.hwp")));
            t1.tree.put("root",Arrays.asList(file("t1a","a.hwp"),file("t1b","b.hwp"),file("t1c","c.hwp")));
            List<String> seenDocs=new ArrayList<>();
            TermuxWalker.Root r0=new TermuxWalker.Root("root","one",t0,(e,folder,format)->seenDocs.add("one/"+e.name),Collections.<String>emptySet(),true);
            TermuxWalker.Root r1=new TermuxWalker.Root("root","two",t1,(e,folder,format)->seenDocs.add("two/"+e.name),Collections.<String>emptySet(),true);
            w=new TermuxWalker(4,never);w.walkAll(Arrays.asList(r0,r1));
            yes(seenDocs.equals(Arrays.asList("one/a.hwp","one/b.hwp","two/a.hwp","two/b.hwp")),"room for 4 documents and 2 trees: both trees are listed: "+seenDocs);
            yes(w.limited&&!w.complete()&&!w.finished(),"the quota made the pass incomplete without being a global stop");
            yes(t1.listed.contains("root"),"the second tree was really queried");
            // Leftover share flows on: an empty first tree leaves everything to the second.
            Fake empty=new Fake();empty.tree.put("root",Collections.<TermuxWalker.Entry>emptyList());seenDocs.clear();
            w=new TermuxWalker(3,never);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","e",empty,(e,folder,format)->seenDocs.add("e"),Collections.<String>emptySet(),true),r1));
            yes(seenDocs.equals(Arrays.asList("two/a.hwp","two/b.hwp","two/c.hwp"))&&w.complete(),"unused share goes to the next tree: "+seenDocs);
            // With a budget of exactly one document per tree, every one of three trees still contributes.
            Fake t2=new Fake();t2.tree.put("root",Arrays.asList(file("t2a","a.hwp"),file("t2b","b.hwp")));seenDocs.clear();
            w=new TermuxWalker(3,never);w.walkAll(Arrays.asList(r0,r1,new TermuxWalker.Root("root","three",t2,(e,folder,format)->seenDocs.add("three/"+e.name),Collections.<String>emptySet(),true)));
            yes(seenDocs.equals(Arrays.asList("one/a.hwp","two/a.hwp","three/a.hwp")),"three trees, three documents: "+seenDocs);
            // A budget that is used up before the last tree leaves it unlisted and the pass incomplete (nothing may be forgotten).
            seenDocs.clear();Fake onlyBig=new Fake();onlyBig.tree.put("root",hundred);Fake lateTree=new Fake();lateTree.tree.put("root",Arrays.asList(file("l1","late.hwp")));
            w=new TermuxWalker(2,never);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","big",onlyBig,(e,folder,format)->seenDocs.add("big"),Collections.<String>emptySet(),true),new TermuxWalker.Root("root","late",lateTree,(e,folder,format)->seenDocs.add("late"),Collections.<String>emptySet(),true)));
            yes(seenDocs.contains("late")&&!w.complete(),"even a tiny budget reaches the last tree: "+seenDocs);
            // A GLOBAL stop does end the loop: cancellation during the first tree leaves the second unlisted and the pass incomplete.
            AtomicBoolean cancel=new AtomicBoolean();Fake stopping=new Fake(){public List<TermuxWalker.Entry> list(String id,int max)throws Exception{cancel.set(true);return super.list(id,max);}};
            stopping.tree.put("root",Arrays.asList(file("s1","s1.hwp")));Fake notReached=new Fake();notReached.tree.put("root",Arrays.asList(file("n1","n1.hwp")));seenDocs.clear();
            w=new TermuxWalker(100,cancel);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","s",stopping,(e,folder,format)->seenDocs.add("s"),Collections.<String>emptySet(),true),new TermuxWalker.Root("root","n",notReached,(e,folder,format)->seenDocs.add("n"),Collections.<String>emptySet(),true)));
            yes(w.finished()&&!w.complete()&&notReached.listed.isEmpty()&&!seenDocs.contains("n"),"cancel ends the multi-tree loop: "+seenDocs+" "+notReached.listed);
            // The wall-clock budget is global too: the walk stops, the unreached tree is unlisted, the pass is incomplete.
            Fake slowOne=new Fake(){public List<TermuxWalker.Entry> list(String id,int max)throws Exception{Thread.sleep(120);return super.list(id,max);}};
            slowOne.tree.put("root",Arrays.asList(dir("sd","sd")));slowOne.tree.put("sd",Arrays.asList(file("sf","sf.hwp")));Fake afterTime=new Fake();afterTime.tree.put("root",Arrays.asList(file("a1","a1.hwp")));seenDocs.clear();
            w=new TermuxWalker(100,never,150);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","slow",slowOne,(e,folder,format)->seenDocs.add("slow"),Collections.<String>emptySet(),true),new TermuxWalker.Root("root","after",afterTime,(e,folder,format)->seenDocs.add("after"),Collections.<String>emptySet(),true)));
            yes(w.finished()&&w.limited&&!w.complete()&&afterTime.listed.isEmpty(),"time budget is a global stop: "+seenDocs+" "+afterTime.listed);
            // An ungranted tree is skipped (and keeps the pass incomplete); the others are still walked.
            seenDocs.clear();w=new TermuxWalker(100,never);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","revoked",t0,(e,folder,format)->seenDocs.add("revoked"),Collections.<String>emptySet(),false),r1));
            yes(seenDocs.size()==3&&seenDocs.get(0).startsWith("two/")&&w.skipped==1&&!w.complete(),"revoked tree skipped, next tree walked: "+seenDocs);
            // The app's scan() really goes through the shared loop and does not decide on its own.
            String folders=new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("app/src/main/java/kr/offline/hwp/TermuxFolders.java")),"UTF-8");
            yes(folders.contains("walker.walkAll(roots)")&&!folders.contains("walker.finished()")&&!folders.contains("walker.walk("),"TermuxFolders.scan uses TermuxWalker.walkAll and no private finished() gate");
        }

        // ---- F-D: equal listings are not proof of an alias ----
        {
            // A genuine nested tree whose folders list the same names/sizes/times as their ancestors, with distinct ids: nothing is dropped.
            Fake nested=new Fake();
            nested.tree.put("root",Arrays.asList(dir("x","x")));
            nested.tree.put("x",Arrays.asList(dir("x/a","a"),file("x/r","r.hwp")));
            nested.tree.put("x/a",Arrays.asList(dir("x/a/a","a"),file("x/a/r","r.hwp")));
            nested.tree.put("x/a/a",Arrays.asList(file("x/a/a/r","r.hwp")));
            w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,nested);Collections.sort(found);
            yes(found.equals(Arrays.asList("Termux · home/x/a/a/r.hwp","Termux · home/x/a/r.hwp","Termux · home/x/r.hwp"))&&w.aliases==0&&w.skipped==0&&w.complete(),"genuine nested matching layout is walked completely: "+found+" aliases="+w.aliases);
            // The same with three identical levels before the layout changes.
            Fake nested3=new Fake();nested3.tree.put("root",Arrays.asList(dir("x","x")));
            String[] chain={"x","x/a","x/a/a","x/a/a/a"};
            for(int i=0;i<chain.length;i++)nested3.tree.put(chain[i],i<chain.length-1?Arrays.asList(dir(chain[i]+"/a","a"),file(chain[i]+"/r","r.hwp")):Arrays.asList(file(chain[i]+"/r","r.hwp")));
            w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,nested3);
            yes(found.size()==4&&w.aliases==0&&w.complete(),"identical levels that end in a different folder are all listed: "+found+" aliases="+w.aliases);
            // The exact layout of the review's reproduction: x/ holds [a/, r.hwp] and x/a/ holds [a/, r.hwp]; the walk must not report that as complete when it dropped something.
            Fake review=new Fake();review.tree.put("root",Arrays.asList(dir("x","x")));review.tree.put("x",Arrays.asList(dir("x/a","a"),file("x/r","r.hwp")));review.tree.put("x/a",Arrays.asList(dir("x/a/a","a"),file("x/a/r","r.hwp")));review.tree.put("x/a/a",Collections.<TermuxWalker.Entry>emptyList());
            w=new TermuxWalker(100,new AtomicBoolean());found=walk(w,review);yes(found.size()==2&&w.complete(),"x and x/a listed, empty x/a/a ends it: "+found);
            // A real symlink alias (`loop -> .`, new ids all the way down) is cut after a bounded number of listings, adds no duplicate documents and
            // is never reported as complete.
            Generated self=new Generated(path->path.replace("/loop",""));
            self.tree.put("p",Arrays.asList(file("a","a.hwp"),dir("sub","sub"),dir("loop","loop")));self.tree.put("p/sub",Arrays.asList(file("b","b.hwpx")));
            w=new TermuxWalker(1000,new AtomicBoolean());found=new ArrayList<>();final List<String> selfFound=found;w.walk("p","Termux · home",self,(e,folder,format)->selfFound.add(folder+"/"+e.name));Collections.sort(found);
            yes(found.equals(Arrays.asList("Termux · home/a.hwp","Termux · home/sub/b.hwpx")),"the alias adds no duplicate documents: "+found);
            yes(w.aliases==1&&w.skipped==1&&!w.complete()&&w.folders<=6&&w.verifyQueries<=TermuxWalker.VERIFY_DEPTH*2,"bounded work, never complete: aliases="+w.aliases+" folders="+w.folders+" verify="+w.verifyQueries);
            // The real Termux layout: nested/loop -> .. (the project folder itself, reached through a longer path).
            Generated up=new Generated(path->{String q=path;while(q.contains("/nested/loop"))q=q.replace("/nested/loop","");return q;});
            up.tree.put("project",Arrays.asList(file("r","termux-remove.hwp"),dir("n","nested"),dir("d","deep"),dir("nm","node_modules"),dir("h",".hidden-notes")));
            up.tree.put("project/nested",Arrays.asList(file("x","termux-nested.hwpx"),dir("l","loop")));up.tree.put("project/deep",Arrays.asList(dir("e","d1")));up.tree.put("project/deep/d1",Arrays.asList(file("y","too-deep.hwpx")));
            found=new ArrayList<>();final List<String> upFound=found;w=new TermuxWalker(1000,new AtomicBoolean());w.walk("project","Termux · project",up,(e,folder,format)->upFound.add(e.name));Collections.sort(found);
            yes(found.equals(Arrays.asList("termux-nested.hwpx","termux-remove.hwp","too-deep.hwpx")),"nested/loop -> .. adds no duplicate: "+found);
            yes(w.aliases==1&&!w.complete()&&w.folders<=8,"loop cut, pass incomplete: aliases="+w.aliases+" folders="+w.folders);
            // A suspected alias that cannot be confirmed (the provider fails while checking) is skipped and counted, never silently dropped as complete.
            Generated flaky=new Generated(path->path.replace("/loop",""));flaky.failOn="/loop/loop";
            flaky.tree.put("p",Arrays.asList(file("a","a.hwp"),dir("loop","loop")));
            found=new ArrayList<>();final List<String> flakyFound=found;w=new TermuxWalker(1000,new AtomicBoolean());w.walk("p","Termux · home",flaky,(e,folder,format)->flakyFound.add(e.name));
            yes(found.equals(Arrays.asList("a.hwp"))&&w.skipped>=1&&!w.complete(),"undecidable suspect: skipped=" + w.skipped);
            // Many suspects: the confirmation work has a hard cap and every folder beyond it is skipped and counted the same way.
            Generated many2=new Generated(path->path.replaceAll("/loop",""));List<TermuxWalker.Entry> tops=new ArrayList<>();
            for(int i=0;i<200;i++){tops.add(dir("k"+i,"k"+i));many2.tree.put("root/k"+i,Arrays.asList(file("f"+i,"x"+i+".hwp"),dir("l"+i,"loop")));}many2.tree.put("root",tops);
            found=new ArrayList<>();final List<String> manyList=found;w=new TermuxWalker(100000,new AtomicBoolean());w.walk("root","Termux · home",many2,(e,folder,format)->manyList.add(e.name));
            yes(found.size()==200&&w.aliases==TermuxWalker.MAX_VERIFY_QUERIES/TermuxWalker.VERIFY_DEPTH/2&&w.aliases+w.undecided==200&&w.skipped==200&&w.verifyQueries<=TermuxWalker.MAX_VERIFY_QUERIES&&!w.complete(),"cap on confirmation work: found="+found.size()+" aliases="+w.aliases+" verify="+w.verifyQueries+" folders="+w.folders);
            yes(w.folders==401,"every folder is still listed exactly once: "+w.folders);
        }

        // ---- TimedCall: an unresponsive provider call is abandoned; a late result is discarded ----
        long t0=System.nanoTime();CountDownLatch release=new CountDownLatch(1);AtomicReference<String> late=new AtomicReference<>();AtomicBoolean cancelled=new AtomicBoolean();
        thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{while(release.getCount()>0){try{release.await();}catch(InterruptedException ignoredLikeBinder){}}return "late value";},null,200,()->cancelled.set(true),late::set),"hung call times out");
        yes((System.nanoTime()-t0)/1_000_000<5000,"timeout returns promptly");
        for(int i=0;i<150&&!cancelled.get();i++)Thread.sleep(20);yes(cancelled.get(),"the provider is cancelled (by a helper thread, a moment after the caller returned)");
        release.countDown();for(int i=0;i<100&&late.get()==null;i++)Thread.sleep(20);yes("late value".equals(late.get()),"late result is handed to discard");
        AtomicBoolean stop2=new AtomicBoolean();CountDownLatch hold=new CountDownLatch(1);new Thread(()->{try{Thread.sleep(150);}catch(InterruptedException ignored){}stop2.set(true);}).start();
        t0=System.nanoTime();thrown(TimedCall.Cancelled.class,()->TimedCall.call(()->{hold.await();return 1;},stop2,60000,null,null),"stop cancels");yes((System.nanoTime()-t0)/1_000_000<5000,"cancel does not wait for the provider");hold.countDown();
        yes(TimedCall.call(()->"ok",null,1000,null,null).equals("ok"),"fast call");
        thrown(FileNotFoundException.class,()->TimedCall.call(()->{throw new FileNotFoundException("gone");},null,1000,null,null),"provider exception is unchanged");
        // A blocked stream read is released by closing the stream (what Termux read() does on timeout).
        PipedOutputStream pipe=new PipedOutputStream();PipedInputStream blocked=new PipedInputStream(pipe);
        thrown(TimedCall.Timeout.class,()->TimedCall.call(()->FileStore.bounded(blocked,1024),null,150,()->{try{blocked.close();}catch(IOException ignored){}},null),"blocked read times out");

        // ---- F-E: the deadline covers the clean-up; cancellation and disposal run on a fixed, bounded set of helper threads ----
        {
            final Thread caller=Thread.currentThread();
            // 1. A cancel callback that takes 500 ms must not stretch a 20 ms deadline.
            CountDownLatch slowCancelDone=new CountDownLatch(1);AtomicReference<Thread> cancelThread=new AtomicReference<>();CountDownLatch hang=new CountDownLatch(1);
            long began=System.nanoTime();
            thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{hang.await();return null;},null,20,()->{cancelThread.set(Thread.currentThread());try{Thread.sleep(500);}catch(InterruptedException ignored){}slowCancelDone.countDown();},null),"slow cancel: timeout");
            long elapsed=(System.nanoTime()-began)/1_000_000;
            yes(elapsed<300,"a 500 ms cancel callback no longer stretches the 20 ms deadline (returned after "+elapsed+" ms)");
            yes(slowCancelDone.await(5,TimeUnit.SECONDS)&&cancelThread.get()!=caller&&cancelThread.get().getName().equals("provider-cleanup"),"the slow cancel still ran, on a helper thread");
            // 2. Blocking cancel callbacks: bounded helpers, bounded queue, excess dropped and counted, never run inline, deadline kept for every call.
            final int calls=40,accepted=TimedCall.CLEANUP_THREADS+TimedCall.CLEANUP_QUEUE;
            CountDownLatch gate=new CountDownLatch(1);AtomicInteger cancelsRun=new AtomicInteger();Set<Thread> cancelThreads=ConcurrentHashMap.newKeySet();int rejectedBefore=TimedCall.cleanupRejected.get();long slowest=0;
            for(int i=0;i<calls;i++){
                long one=System.nanoTime();
                thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{new CountDownLatch(1).await();return null;},null,20,()->{cancelThreads.add(Thread.currentThread());cancelsRun.incrementAndGet();try{gate.await();}catch(InterruptedException ignored){}},null),"blocking cancel: timeout "+i);
                slowest=Math.max(slowest,(System.nanoTime()-one)/1_000_000);
            }
            yes(slowest<400,"every call met its deadline although every cancel callback blocks (slowest "+slowest+" ms)");
            yes(TimedCall.cleanupThreads()<=TimedCall.CLEANUP_THREADS,"helper threads stay at the fixed number: "+TimedCall.cleanupThreads());
            long helperThreads=Thread.getAllStackTraces().keySet().stream().filter(t->t.getName().equals("provider-cleanup")).count();yes(helperThreads<=TimedCall.CLEANUP_THREADS,"no abandoned helper threads pile up: "+helperThreads);
            yes(TimedCall.cleanupRejected.get()-rejectedBefore==calls-accepted,"the clean-ups beyond the helpers and the queue are dropped and counted: "+(TimedCall.cleanupRejected.get()-rejectedBefore));
            gate.countDown();for(int i=0;i<200&&cancelsRun.get()<accepted;i++)Thread.sleep(20);
            yes(cancelsRun.get()==accepted&&!cancelThreads.contains(caller),"accepted cancels run once the helpers are free, a rejected one is never run inline: ran "+cancelsRun.get());
            // 3. An interrupted caller still gets Cancelled, keeps its interrupt flag, and the cancel runs off its thread.
            AtomicReference<Throwable> outcome=new AtomicReference<>();AtomicBoolean flag=new AtomicBoolean();CountDownLatch interruptCancel=new CountDownLatch(1);AtomicReference<Thread> intThread=new AtomicReference<>();
            Thread interrupted=new Thread(()->{Thread.currentThread().interrupt();try{TimedCall.call(()->{new CountDownLatch(1).await();return null;},null,60000,()->{intThread.set(Thread.currentThread());interruptCancel.countDown();},null);}catch(Throwable t){outcome.set(t);}flag.set(Thread.currentThread().isInterrupted());});
            interrupted.start();interrupted.join(5000);
            yes(outcome.get() instanceof TimedCall.Cancelled&&flag.get()&&interruptCancel.await(5,TimeUnit.SECONDS)&&intThread.get()!=interrupted,"interrupt: Cancelled, flag kept, cancel on a helper: "+outcome.get());
            // 4. A late result is disposed of exactly once, never on the caller's thread, even when the caller gives up the instant the call finishes.
            AtomicInteger disposed=new AtomicInteger(),produced=new AtomicInteger(),received=new AtomicInteger();Set<Thread> disposers=ConcurrentHashMap.newKeySet();final int rounds=1000;
            Thread racing=new Thread(()->{for(int i=0;i<rounds;i++){Thread.currentThread().interrupt();try{TimedCall.call(()->{long spin=System.nanoTime()+java.util.concurrent.ThreadLocalRandom.current().nextLong(0,300_000);while(System.nanoTime()<spin){}produced.incrementAndGet();return "v";},null,60000,null,v->{disposers.add(Thread.currentThread());disposed.incrementAndGet();});received.incrementAndGet();}catch(TimedCall.Cancelled expected){}catch(IOException busyPool){/* all provider threads are still finishing earlier spins: refused at once, which is the designed behaviour */}catch(Exception e){throw new AssertionError(e);}Thread.interrupted();}},"racing");
            racing.start();racing.join(30000);
            for(int i=0;i<200&&disposed.get()<produced.get()-received.get();i++)Thread.sleep(20);Thread.sleep(100);
            // (a call cancelled before its worker started produces no value, and a call whose result was already there is returned normally)
            yes(produced.get()-received.get()>0&&disposed.get()==produced.get()-received.get()&&!disposers.contains(racing),"every abandoned result is disposed of exactly once, off the caller: disposed "+disposed.get()+", produced "+produced.get()+", handed to the caller "+received.get());
            // 5. A blocking disposer does not hold the caller either.
            CountDownLatch release2=new CountDownLatch(1),disposeGate=new CountDownLatch(1);AtomicReference<String> lateValue=new AtomicReference<>();
            began=System.nanoTime();thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{while(release2.getCount()>0){try{release2.await();}catch(InterruptedException ignoredLikeBinder){}}return "late";},null,20,null,v->{lateValue.set(v);try{disposeGate.await();}catch(InterruptedException ignored){}}),"blocking disposer: timeout");
            yes((System.nanoTime()-began)/1_000_000<300,"deadline held");release2.countDown();for(int i=0;i<150&&lateValue.get()==null;i++)Thread.sleep(20);yes("late".equals(lateValue.get()),"late value reached the disposer");disposeGate.countDown();
            // 6. Capacity: when every provider thread is stuck in a call that ignores interruption, a new call is refused at once ("busy"), and calls work again once they end.
            CountDownLatch stuck=new CountDownLatch(1);
            for(int i=0;i<TimedCall.MAX_WORKERS;i++)thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{while(stuck.getCount()>0){try{stuck.await();}catch(InterruptedException ignoredLikeBinder){}}return null;},null,20,null,null),"stuck call "+i);
            began=System.nanoTime();thrown(IOException.class,()->TimedCall.call(()->"never",null,5000,null,null),"busy: the next call is refused");
            yes((System.nanoTime()-began)/1_000_000<300,"a refused call returns at once instead of waiting for a free thread");
            try{TimedCall.call(()->"never",null,5000,null,null);yes(false,"still busy");}catch(TimedCall.Timeout notThis){yes(false,"busy is not a timeout");}catch(IOException busy){yes(busy.getMessage().contains("이전 요청"),"busy message: "+busy.getMessage());}
            stuck.countDown();String again=null;for(int i=0;i<200&&again==null;i++){try{again=TimedCall.call(()->"free again",null,1000,null,null);}catch(IOException stillBusy){Thread.sleep(20);}}
            yes("free again".equals(again),"calls work again after the stuck ones end");
        }

        // ---- F-E follow-up: a value the caller never took is owned by its provider worker until disposed (blocked cancel, saturated helpers, delivery race) ----
        {
            final Thread caller=Thread.currentThread();
            // Saturate the cancel helpers: 2 running + 16 queued cancel callbacks that never return (until the gate opens).
            CountDownLatch gate=new CountDownLatch(1);AtomicInteger blockedCancels=new AtomicInteger();
            for(int i=0;i<TimedCall.CLEANUP_THREADS+TimedCall.CLEANUP_QUEUE;i++)
                thrown(TimedCall.Timeout.class,()->TimedCall.call(()->{new CountDownLatch(1).await();return null;},null,20,()->{blockedCancels.incrementAndGet();try{gate.await();}catch(InterruptedException ignored){}},null),"saturating call "+i);
            int rejectedBefore=TimedCall.cleanupRejected.get();
            // 1. The delivery race, forced: the worker has published its value (DELIVERED) when the caller's deadline passes.
            //    The cancel callback blocks forever and the cleanup pool is full, so the cancel is dropped; the value must still be closed, exactly once,
            //    by the provider worker, while the cancel gate is still closed.
            CountDownLatch holdWorker=new CountDownLatch(1);AtomicInteger closed=new AtomicInteger();AtomicReference<Thread> closer=new AtomicReference<>();CountDownLatch closedLatch=new CountDownLatch(1);
            long began=System.nanoTime();
            thrown(TimedCall.Timeout.class,()->TimedCall.call(()->"cursor",null,20,()->{try{gate.await();}catch(InterruptedException ignored){}},v->{closer.set(Thread.currentThread());closed.incrementAndGet();closedLatch.countDown();},()->{while(holdWorker.getCount()>0){try{holdWorker.await();}catch(InterruptedException ignoredLikeBinder){}}}),"delivery race: timeout");
            yes((System.nanoTime()-began)/1_000_000<300,"the caller's deadline holds although the worker sits on a delivered value");
            yes(TimedCall.cleanupRejected.get()==rejectedBefore+1&&closed.get()==0,"the cancel was dropped by the full pool and counted; the value is not closed yet (the worker still holds it): rejected +"+(TimedCall.cleanupRejected.get()-rejectedBefore)+" closed "+closed.get()+" blockedCancels "+blockedCancels.get());
            holdWorker.countDown();
            yes(closedLatch.await(5,TimeUnit.SECONDS)&&gate.getCount()==1,"the value is closed although the cancel never returns and was never run");
            Thread.sleep(100);
            yes(closed.get()==1&&closer.get()!=caller&&closer.get().getName().equals("provider-call"),"closed exactly once, by a provider worker, never inline on the caller");
            // 2. Many calls under the same blocked/saturated state, caller interrupted so it gives up at an arbitrary moment relative to delivery:
            //    every value that was produced and not taken is closed, none depends on the cancel.
            AtomicInteger produced=new AtomicInteger(),taken=new AtomicInteger(),disposed=new AtomicInteger();Set<Thread> disposers=ConcurrentHashMap.newKeySet();
            final int rounds=600;long slowest=0;
            Thread racing=new Thread(()->{
                for(int i=0;i<rounds;i++){
                    Thread.currentThread().interrupt();
                    try{TimedCall.call(()->{long spin=System.nanoTime()+ThreadLocalRandom.current().nextLong(0,300_000);while(System.nanoTime()<spin){}produced.incrementAndGet();return "v";},null,60000,()->{try{gate.await();}catch(InterruptedException ignored){}},v->{disposers.add(Thread.currentThread());disposed.incrementAndGet();});taken.incrementAndGet();}
                    catch(TimedCall.Cancelled expected){}catch(IOException busyPool){}catch(Exception e){throw new AssertionError(e);}
                    Thread.interrupted();
                }},"racing2");
            racing.start();racing.join(60000);
            for(int i=0;i<200&&disposed.get()<produced.get()-taken.get();i++)Thread.sleep(20);Thread.sleep(100);
            yes(produced.get()-taken.get()>0&&disposed.get()==produced.get()-taken.get(),"every abandoned value is closed with the cancel blocked and the helpers saturated: closed "+disposed.get()+", produced "+produced.get()+", taken "+taken.get());
            yes(TimedCall.cleanupRejected.get()>rejectedBefore+1&&!disposers.contains(racing)&&disposers.stream().allMatch(t->t.getName().equals("provider-call")),"the dropped cancels were counted; every close ran on a provider worker");
            yes(TimedCall.cleanupThreads()<=TimedCall.CLEANUP_THREADS&&Thread.getAllStackTraces().keySet().stream().filter(t->t.getName().equals("provider-cleanup")).count()<=TimedCall.CLEANUP_THREADS,"threads stay bounded");
            // 3. A value the caller took is its own: the library never closes it.
            AtomicInteger lonely=new AtomicInteger();
            TimedCall.call(()->"lonely",null,5000,null,v->lonely.incrementAndGet());
            yes(lonely.get()==0,"a value the caller took is never closed by the library");
            gate.countDown();
            for(int i=0;i<200&&blockedCancels.get()<TimedCall.CLEANUP_THREADS+TimedCall.CLEANUP_QUEUE;i++)Thread.sleep(20);
        }

        // ---- N2: alias confirmation obeys the wall clock, the query allowance, the entry budgets and the other trees' share (through the real walkAll gate) ----
        {
            AtomicBoolean never=new AtomicBoolean();
            // 1. Slow confirmation listings (600 ms each): the pass's 400 ms budget ends the walk after the first one, not after all six.
            final List<Long> budgets=Collections.synchronizedList(new ArrayList<Long>());
            Generated slowSelf=new Generated(path->path.replace("/loop","")){
                public List<TermuxWalker.Entry> list(String id,int max,long budgetMs)throws Exception{budgets.add(budgetMs);if(id.contains("loop/")){Thread.sleep(600);}return list(id,max);}
            };
            slowSelf.tree.put("p",Arrays.asList(file("a","a.hwp"),dir("sub","sub"),dir("loop","loop")));slowSelf.tree.put("p/sub",Arrays.asList(file("b","b.hwpx")));
            List<String> seenDocs=new ArrayList<>();
            w=new TermuxWalker(1000,never,400);long began=System.nanoTime();
            w.walkAll(Arrays.asList(new TermuxWalker.Root("p","Termux · home",slowSelf,(e,folder,format)->seenDocs.add(e.name),Collections.<String>emptySet(),true)));
            long took=(System.nanoTime()-began)/1_000_000;
            yes(took<1300,"slow confirmation listings end at the time budget, not after six of them: "+took+" ms");
            yes(w.undecided==1&&w.aliases==0&&w.skipped>=1&&w.finished()&&!w.complete(),"the suspect is undecided (skipped), the wall clock is up, the pass is incomplete: undecided="+w.undecided+" skipped="+w.skipped);
            yes(budgets.size()==4&&budgets.stream().allMatch(b->b>0&&b<=400),"every query (3 listings + the one confirmation that ran) was given at most the wall clock that was left, none after it ran out: "+budgets);
            // 2. Provider timeouts during confirmation stop further confirmation after MAX_CONSECUTIVE_FAILURES, like ordinary listings.
            Generated stalled=new Generated(path->path.replaceAll("/loop","")){
                public List<TermuxWalker.Entry> list(String id,int max,long budgetMs)throws Exception{if(id.contains("/loop/"))throw new TimedCall.Timeout("slow");return list(id,max);}
            };
            List<TermuxWalker.Entry> tops=new ArrayList<>();for(int i=0;i<10;i++){tops.add(dir("k"+i,"k"+i));stalled.tree.put("root/k"+i,Arrays.asList(file("f"+i,"x"+i+".hwp"),dir("l"+i,"loop")));}stalled.tree.put("root",tops);
            // every suspect's first confirmation query is "root/kN/loop/loop" (contains /loop/): it times out
            seenDocs.clear();w=new TermuxWalker(1000,never);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","Termux · home",stalled,(e,folder,format)->seenDocs.add(e.name),Collections.<String>emptySet(),true)));
            yes(w.verifyQueries==TermuxWalker.MAX_CONSECUTIVE_FAILURES&&w.undecided==10&&seenDocs.size()==10&&!w.complete(),"confirmation stops after "+TermuxWalker.MAX_CONSECUTIVE_FAILURES+" timeouts: queries="+w.verifyQueries+" undecided="+w.undecided);
            // 3. A listing longer than the comparison cap hides what differs beyond it: undecidable, never "confirmed", and what it read is counted.
            final int wideSize=TermuxWalker.VERIFY_MAX_ENTRIES+500;
            Fake wide2=new Fake();wide2.tree.put("root",Arrays.asList(dir("x","x")));
            for(String id:new String[]{"x","x/a"}){List<TermuxWalker.Entry> l=new ArrayList<>();l.add(dir(id+"/a","a"));l.add(file(id+"/r","r.hwp"));for(int i=0;i<wideSize;i++)l.add(new TermuxWalker.Entry(id+"/f"+i,"f"+i+".txt",false,10,1));wide2.tree.put(id,l);}
            {List<TermuxWalker.Entry> l=new ArrayList<>();l.add(dir("x/a/a/a","a"));l.add(file("x/a/a/r","r.hwp"));for(int i=0;i<wideSize-1;i++)l.add(new TermuxWalker.Entry("x/a/a/f"+i,"f"+i+".txt",false,10,1));l.add(new TermuxWalker.Entry("x/a/a/f"+(wideSize-1),"f"+(wideSize-1)+".txt",false,99,7));wide2.tree.put("x/a/a",l);}   // differs only past the cap
            final List<Integer> asked=Collections.synchronizedList(new ArrayList<Integer>());
            Fake recording=new Fake(){public List<TermuxWalker.Entry> list(String id,int max,long budgetMs)throws Exception{asked.add(max);return super.list(id,max);}};recording.tree.putAll(wide2.tree);
            seenDocs.clear();w=new TermuxWalker(100000,never);w.walkAll(Arrays.asList(new TermuxWalker.Root("root","Termux · home",recording,(e,folder,format)->seenDocs.add(e.name),Collections.<String>emptySet(),true)));
            yes(w.aliases==0&&w.undecided==1&&w.skipped==1&&!w.complete(),"a truncated confirmation listing is undecidable, not an alias: aliases="+w.aliases+" undecided="+w.undecided);
            yes(asked.stream().filter(m->m==TermuxWalker.VERIFY_MAX_ENTRIES).count()>=1&&w.verifyQueries>=1,"confirmation asked for at most the cap: "+asked.stream().distinct().collect(java.util.stream.Collectors.toList()));
            yes(w.entries>=wideSize+TermuxWalker.VERIFY_MAX_ENTRIES,"the entries confirmation read count toward the entry budget: entries="+w.entries);
            // 4. One tree full of suspects cannot use up the confirmation work of the tree after it.
            Generated loopy=new Generated(path->path.replaceAll("/loop",""));List<TermuxWalker.Entry> manyTops=new ArrayList<>();
            for(int i=0;i<200;i++){manyTops.add(dir("k"+i,"k"+i));loopy.tree.put("root/k"+i,Arrays.asList(file("f"+i,"x"+i+".hwp"),dir("l"+i,"loop")));}loopy.tree.put("root",manyTops);
            Fake genuine=new Fake();genuine.tree.put("root",Arrays.asList(dir("x","x")));genuine.tree.put("x",Arrays.asList(dir("x/a","a"),file("x/r","r.hwp")));genuine.tree.put("x/a",Arrays.asList(dir("x/a/a","a"),file("x/a/r","r.hwp")));genuine.tree.put("x/a/a",Arrays.asList(file("x/a/a/r","r.hwp")));
            List<String> second=new ArrayList<>();w=new TermuxWalker(100000,never);
            w.walkAll(Arrays.asList(new TermuxWalker.Root("root","loops",loopy,(e,folder,format)->seenDocs.add(e.name),Collections.<String>emptySet(),true),new TermuxWalker.Root("root","genuine",genuine,(e,folder,format)->second.add(e.name),Collections.<String>emptySet(),true)));
            yes(second.size()==3&&w.verifyQueries<=TermuxWalker.MAX_VERIFY_QUERIES&&!w.complete(),"the second tree's equal-layout folder was still confirmed and listed after a loop-heavy first tree: "+second+" verify="+w.verifyQueries);
            yes(w.undecided>0&&w.aliases>0,"the first tree ran out of its share (undecided "+w.undecided+") after confirming some aliases ("+w.aliases+")");
        }
        System.out.println("TermuxWalker/TimedCall: "+checks+" checks passed");
    }
}
