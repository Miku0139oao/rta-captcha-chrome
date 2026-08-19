# Generates Chrome Web Store icons and a 1280x800 listing screenshot.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "icons"
$storeDir = Join-Path $root "store"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
New-Item -ItemType Directory -Force -Path $storeDir | Out-Null

function New-SolidBrush([int]$r, [int]$g, [int]$b) {
  return New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $r, $g, $b))
}

function Save-Png([System.Drawing.Bitmap]$bitmap, [string]$path) {
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function New-Icon([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 15, 23, 42))

  $pad = [Math]::Max(2, [int]($size * 0.12))
  $radius = [Math]::Max(3, [int]($size * 0.18))
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $fill = New-SolidBrush 14 116 144
  $graphics.FillPath($fill, $path)

  $cell = [Math]::Max(2, [int]($size * 0.11))
  $gap = [Math]::Max(1, [int]($size * 0.04))
  $blockWidth = 5 * $cell + 4 * $gap
  $blockHeight = 2 * $cell + $gap
  $originX = [int](($size - $blockWidth) / 2)
  $originY = [int](($size - $blockHeight) / 2)
  $ink = New-SolidBrush 248 250 252
  $muted = New-SolidBrush 125 211 252
  $pattern = @(
    @(1, 0, 1, 1, 0),
    @(0, 1, 1, 0, 1)
  )
  for ($row = 0; $row -lt 2; $row++) {
    for ($col = 0; $col -lt 5; $col++) {
      $brush = if ($pattern[$row][$col] -eq 1) { $ink } else { $muted }
      $x = $originX + $col * ($cell + $gap)
      $y = $originY + $row * ($cell + $gap)
      $graphics.FillRectangle($brush, $x, $y, $cell, $cell)
    }
  }

  Save-Png $bitmap (Join-Path $iconDir "icon$size.png")
  $graphics.Dispose()
  $bitmap.Dispose()
  $fill.Dispose()
  $ink.Dispose()
  $muted.Dispose()
  $path.Dispose()
}

foreach ($size in 16, 32, 48, 128) {
  New-Icon $size
}

$shot = New-Object System.Drawing.Bitmap 1280, 800
$g = [System.Drawing.Graphics]::FromImage($shot)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(255, 248, 250, 252))

$header = New-SolidBrush 15 23 42
$g.FillRectangle($header, 0, 0, 1280, 96)
$titleFont = New-Object System.Drawing.Font "Segoe UI", 28, ([System.Drawing.FontStyle]::Bold)
$subFont = New-Object System.Drawing.Font "Segoe UI", 16
$bodyFont = New-Object System.Drawing.Font "Microsoft JhengHei UI", 22, ([System.Drawing.FontStyle]::Bold)
$smallFont = New-Object System.Drawing.Font "Microsoft JhengHei UI", 16
$white = New-SolidBrush 248 250 252
$ink = New-SolidBrush 15 23 42
$mutedText = New-SolidBrush 71 85 105
$card = New-SolidBrush 255 255 255
$accent = New-SolidBrush 14 116 144
$ok = New-SolidBrush 22 163 74

$g.DrawString("RTA Captcha OCR", $titleFont, $white, 40, 22)
$g.DrawString("Chrome / Edge 本機驗證碼辨識", $subFont, $white, 420, 38)

function Draw-Card([int]$x, [int]$y, [int]$w, [int]$h, [string]$heading, [string]$body) {
  $g.FillRectangle($card, $x, $y, $w, $h)
  $g.FillRectangle($accent, $x, $y, 8, $h)
  $g.DrawString($heading, $bodyFont, $ink, ($x + 36), ($y + 28))
  $g.DrawString($body, $smallFont, $mutedText, ($x + 36), ($y + 84))
}

Draw-Card 48 140 1184 140 "只填驗證碼，不送出登入" "辨識成功後只寫入 verifyCode 欄位。帳號、密碼與登入按鈕都不會被碰到。"
Draw-Card 48 308 1184 140 "全部在你的電腦上運算" "OCR 在擴充功能 Worker 內執行。圖片不會上傳到第三方 OCR 或遠端 API。"
Draw-Card 48 476 1184 140 "只在 RTA SSO 生效" "權限限於 sso.rta-os.com 與 mansso.rta-os.com。其他網站不會注入。"

$g.FillRectangle($ok, 48, 656, 16, 16)
$g.DrawString("不確定時不會亂填；最多自動換圖 4 次。登入仍由使用者確認後送出。", $smallFont, $ink, 76, 648)

Save-Png $shot (Join-Path $storeDir "screenshot-1280x800.png")
Copy-Item (Join-Path $iconDir "icon128.png") (Join-Path $storeDir "icon-128.png")

$g.Dispose()
$shot.Dispose()
$titleFont.Dispose()
$subFont.Dispose()
$bodyFont.Dispose()
$smallFont.Dispose()
$header.Dispose()
$white.Dispose()
$ink.Dispose()
$mutedText.Dispose()
$card.Dispose()
$accent.Dispose()
$ok.Dispose()

Write-Output "Wrote icons and store/screenshot-1280x800.png"
