Option Explicit
Dim shell, fs, root, cli, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
cli = fs.BuildPath(root, "apps\cli\dist\src\index.js")
If Not fs.FileExists(cli) Then
  MsgBox "Build MCPex first: npm run build", 48, "MCPex"
  WScript.Quit 1
End If
On Error Resume Next
result = shell.Run("node """ & cli & """ open", 0, True)
If Err.Number <> 0 Then
  MsgBox "Could not start Node.js. Check that Node.js is installed and available in PATH.", 48, "MCPex"
  WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then
  MsgBox "Could not open MCPex settings. Run the following command in a terminal to see details:" & vbCrLf & "node """ & cli & """ open", 48, "MCPex"
End If
WScript.Quit result
