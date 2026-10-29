# WinForms target for the cua-vs-Orca background bench. Writes its state to state.json every 30 ms
# and obeys one-word commands written to cmd (reset, setHello).
param([string]$StateDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$statePath = Join-Path $StateDir "state.json"
$cmdPath = Join-Path $StateDir "cmd"
$script:count = 0
$script:returns = 0
$script:menuHits = 0
$script:last = ""

$form = New-Object System.Windows.Forms.Form
$form.Text = "BenchTarget"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(60, 60)
$form.Size = New-Object System.Drawing.Size(760, 560)

$menu = New-Object System.Windows.Forms.MenuStrip
$edit = New-Object System.Windows.Forms.ToolStripMenuItem("Edit")
$bump = New-Object System.Windows.Forms.ToolStripMenuItem("Bump")
$bump.ShortcutKeys = [System.Windows.Forms.Keys]::Control -bor [System.Windows.Forms.Keys]::B
$bump.Add_Click({ $script:menuHits++ })
[void]$edit.DropDownItems.Add($bump)
[void]$menu.Items.Add($edit)
$form.MainMenuStrip = $menu
$form.Controls.Add($menu)

$button = New-Object System.Windows.Forms.Button
$button.Text = "Increment"
$button.Location = New-Object System.Drawing.Point(20, 40)
$button.Add_Click({ $script:count++ })
$form.Controls.Add($button)

$check = New-Object System.Windows.Forms.CheckBox
$check.Text = "Check me"
$check.Location = New-Object System.Drawing.Point(20, 80)
$form.Controls.Add($check)

$field = New-Object System.Windows.Forms.TextBox
$field.Name = "field"
$field.AccessibleName = "field"
$field.Location = New-Object System.Drawing.Point(20, 120)
$field.Width = 300
$field.Add_KeyDown({
    param($sender, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $script:returns++; $e.SuppressKeyPress = $true }
})
$form.Controls.Add($field)

$combo = New-Object System.Windows.Forms.ComboBox
$combo.DropDownStyle = "DropDownList"
$combo.AccessibleName = "Color"
[void]$combo.Items.AddRange(@("Red", "Green", "Blue"))
$combo.SelectedIndex = 0
$combo.Location = New-Object System.Drawing.Point(20, 160)
$form.Controls.Add($combo)

$list = New-Object System.Windows.Forms.ListBox
$list.AccessibleName = "list"
$list.Location = New-Object System.Drawing.Point(20, 200)
$list.Size = New-Object System.Drawing.Size(300, 250)
foreach ($i in 1..300) { [void]$list.Items.Add("Row $i") }
$form.Controls.Add($list)

function Invoke-BenchCommand([string]$c) {
    switch ($c) {
        "reset" {
            $script:count = 0; $script:returns = 0; $script:menuHits = 0
            $check.Checked = $false
            $edit.HideDropDown()
            $combo.SelectedIndex = 0
            $list.TopIndex = 0
            $field.Text = ""
            $form.ActiveControl = $field
        }
        "setHello" {
            $form.ActiveControl = $field
            $field.Text = "hello"
            $field.SelectionStart = 5
            $field.SelectionLength = 0
            $script:returns = 0
        }
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
    try {
        if (Test-Path $cmdPath) {
            $c = ([IO.File]::ReadAllText($cmdPath)).Trim()
            if ($c) { [IO.File]::WriteAllText($cmdPath, ""); Invoke-BenchCommand $c }
        }
    } catch {}
    $state = [ordered]@{
        count = $script:count; check = $check.Checked; text = $field.Text; returns = $script:returns
        selStart = $field.SelectionStart; selLen = $field.SelectionLength; combo = [string]$combo.SelectedItem
        top = $list.TopIndex; menuHits = $script:menuHits; dropOpen = $edit.DropDown.Visible
        activeForm = ($null -ne [System.Windows.Forms.Form]::ActiveForm); fieldFocused = $field.Focused
        pid = $PID
    }
    $json = $state | ConvertTo-Json -Compress
    if ($json -ne $script:last) {
        try { [IO.File]::WriteAllText($statePath, $json); $script:last = $json } catch {}
    }
})
$form.Add_Shown({ $form.ActiveControl = $field; $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
