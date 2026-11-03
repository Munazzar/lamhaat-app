# Shows Windows' own "Select folder" window (the File Explorer one) and prints the chosen path.
# Prints nothing if the person cancels. Built into Windows: nothing to install.
param([string]$Start = '', [string]$Title = 'Choose a folder')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si); void SetFolder(IShellItem si);
    void GetFolder(); void GetCurrentSelection(); void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel(); void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem { void BindToHandler(); void GetParent(); void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem si);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string start, string title) {
    var d = (IFileOpenDialog)new FileOpenDialog();
    d.SetOptions(0x20 | 0x40 | 0x800); // pick folders, file-system only, must exist
    d.SetTitle(title);
    d.SetOkButtonLabel("Select folder");
    if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
      IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out si); d.SetFolder(si);
    }
    if (d.Show(GetForegroundWindow()) != 0) return null;
    IShellItem r; d.GetResult(out r); string path; r.GetDisplayName(0x80058000, out path); return path;
  }
}
'@
$p = [FolderPicker]::Pick($Start, $Title)
if ($p) { [Console]::Out.Write($p) }
