' Starts Lamhaat without a console window. The app opens its own window and quits when it is closed.
' Uses the Node that comes with it (node\node.exe, in the downloaded app), else the one on the PATH.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "node"
If fso.FileExists(sh.CurrentDirectory & "\node\node.exe") Then node = """" & sh.CurrentDirectory & "\node\node.exe"""
sh.Run node & " --no-warnings desktop\server.js", 0, False
