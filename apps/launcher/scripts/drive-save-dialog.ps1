param(
  [Parameter(Mandatory=$true)][int]$OwnerProcessId,
  [Parameter(Mandatory=$true)][ValidateSet('save','cancel')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($Destination)
$root = [System.IO.Path]::GetDirectoryName($target)
$parent = [System.IO.Path]::GetDirectoryName($root)
if ($parent -ne [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') -or -not [System.IO.Path]::GetFileName($root).StartsWith('launcher-smoke-')) { throw 'Invalid owned dialog destination' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedDialogControl {
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$conditions = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnerProcessId),
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Owned G4 Save Fixture')
)
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$dialog = $null
while ($watch.ElapsedMilliseconds -lt 8000) {
  $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $conditions)
  if ($null -ne $dialog) { break }
  Start-Sleep -Milliseconds 50
}
if ($null -eq $dialog) { throw 'Owned native Save dialog not found' }
$dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
function Get-OwnedHandle($element, [string]$ExpectedClass) {
  $handle = [IntPtr]$element.Current.NativeWindowHandle
  [uint32]$actualProcess = 0
  [void][OwnedDialogControl]::GetWindowThreadProcessId($handle, [ref]$actualProcess)
  $class = [System.Text.StringBuilder]::new(256)
  [void][OwnedDialogControl]::GetClassName($handle, $class, $class.Capacity)
  if ($handle -eq [IntPtr]::Zero -or $actualProcess -ne $OwnerProcessId -or -not [OwnedDialogControl]::IsChild($dialogHandle, $handle) -or $class.ToString() -ne $ExpectedClass) { throw 'Unowned native dialog control rejected' }
  return $handle
}
function Get-OwnedControl([string]$Id, [string]$Class) {
  return $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id),
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, $Class)
    ))
}
if ($Action -eq 'save') {
  $edit = $null
  while ($watch.ElapsedMilliseconds -lt 8000) {
    # This Windows build exposes native Edit/Button HWNDs as UIA Pane without patterns.
    $edit = Get-OwnedControl '1001' 'Edit'
    if ($null -ne $edit) { break }
    Start-Sleep -Milliseconds 50
  }
  if ($null -eq $edit) {
    $fields = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit'))
    $details = @($fields | ForEach-Object { @{ id=$_.Current.AutomationId; class=$_.Current.ClassName; type=$_.Current.ControlType.ProgrammaticName } })
    throw ('Owned filename control not found: ' + ($details | ConvertTo-Json -Compress))
  }
  $editHandle = Get-OwnedHandle $edit 'Edit'
  [UIntPtr]$result = [UIntPtr]::Zero
  if ([OwnedDialogControl]::SendMessageTimeout($editHandle, 0x000C, [UIntPtr]::Zero, $target, 2, 1000, [ref]$result) -eq [IntPtr]::Zero) { throw 'Owned filename write failed' }
  $text = [System.Text.StringBuilder]::new($target.Length + 1)
  if ([OwnedDialogControl]::SendMessageTimeout($editHandle, 0x000D, [UIntPtr]::new($text.Capacity), $text, 2, 1000, [ref]$result) -eq [IntPtr]::Zero -or $text.ToString() -ne $target) { throw 'Owned filename verification failed' }
}
$buttonId = if ($Action -eq 'save') { '1' } else { '2' }
$button = Get-OwnedControl $buttonId 'Button'
if ($null -eq $button) { throw 'Owned dialog button not found' }
$buttonHandle = Get-OwnedHandle $button 'Button'
[UIntPtr]$result = [UIntPtr]::Zero
if ([OwnedDialogControl]::SendMessageTimeout($buttonHandle, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$result) -eq [IntPtr]::Zero) { throw 'Owned dialog button invocation failed' }
Write-Output ('owned-native-dialog-' + $Action)
