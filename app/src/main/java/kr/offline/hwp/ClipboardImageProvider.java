package kr.offline.hwp;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Read-only, opaque clipboard images. The only files it can ever serve are PNGs this app wrote into its own private cache directory
 * under a random name (no path from a caller is ever resolved), and only through a URI the system grants to the pasting app together
 * with the clip (the provider is not exported). It never accepts writes.
 */
public final class ClipboardImageProvider extends ContentProvider {
    static final String DIRECTORY = "clipboard";
    private static final Pattern NAME = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png");
    private static final int KEEP = 4;

    static String authority(Context context){return context.getPackageName()+".clipboard";}

    /** Stores validated PNG bytes and returns the opaque content URI for a clip. Older images beyond the newest few are removed. */
    static Uri publish(Context context,byte[] png)throws IOException {
        File directory=new File(context.getCacheDir(),DIRECTORY);
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("클립보드 이미지를 보관할 수 없어요.");
        prune(directory,KEEP-1);
        String name=UUID.randomUUID()+".png";File file=new File(directory,name);
        try(FileOutputStream out=new FileOutputStream(file)){out.write(png);out.getFD().sync();}
        return new Uri.Builder().scheme("content").authority(authority(context)).appendPath(name).build();
    }
    /** Keeps the newest {@code keep} files; also used at start-up to drop images left by an earlier process. */
    static void prune(File directory,int keep){
        File[] files=directory.listFiles((dir,name)->NAME.matcher(name).matches());if(files==null)return;
        Arrays.sort(files,Comparator.comparingLong(File::lastModified).reversed());
        for(int index=Math.max(0,keep);index<files.length;index++)files[index].delete();
    }
    static void sweep(Context context){File directory=new File(context.getCacheDir(),DIRECTORY);if(directory.isDirectory())prune(directory,0);}
    /** Resolves only a single well-formed segment inside the private directory. Anything else is not a file we serve. */
    private File resolve(Uri uri)throws FileNotFoundException {
        if(uri==null||uri.getPathSegments().size()!=1)throw new FileNotFoundException();
        String name=uri.getLastPathSegment();if(name==null||!NAME.matcher(name).matches())throw new FileNotFoundException();
        File file=new File(new File(getContext().getCacheDir(),DIRECTORY),name);if(!file.isFile())throw new FileNotFoundException();
        return file;
    }
    @Override public boolean onCreate(){return true;}
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException {
        if(!"r".equals(mode))throw new SecurityException("읽기 전용이에요.");
        return ParcelFileDescriptor.open(resolve(uri),ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public String getType(Uri uri){try{resolve(uri);return "image/png";}catch(FileNotFoundException missing){return null;}}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] selectionArgs,String sortOrder){
        File file;try{file=resolve(uri);}catch(FileNotFoundException missing){return null;}
        String[] columns=projection!=null?projection:new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE};
        MatrixCursor cursor=new MatrixCursor(columns,1);Object[] row=new Object[columns.length];
        for(int index=0;index<columns.length;index++)row[index]=OpenableColumns.DISPLAY_NAME.equals(columns[index])?"image.png":OpenableColumns.SIZE.equals(columns[index])?(Object)file.length():null;
        cursor.addRow(row);return cursor;
    }
    @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    @Override public int delete(Uri uri,String selection,String[] selectionArgs){throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] selectionArgs){throw new UnsupportedOperationException();}
}
