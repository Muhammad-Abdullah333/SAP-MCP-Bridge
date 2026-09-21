Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run Chr(34) & root & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & root & "\src\manager.js" & Chr(34), 0, False
