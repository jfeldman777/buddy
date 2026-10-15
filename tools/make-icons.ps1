# Generates Buddy icons into web/icons/: bright green square, white circle with black border, lowercase black "db".
# The circle stays inside the 80% maskable safe zone, so the same PNGs serve as "any" and "maskable".
# Usage: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\web\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$green = [Drawing.Color]::FromArgb(255, 40, 255, 55)

function New-BuddyIcon([int]$size, [string]$fileName) {
    $bmp = New-Object Drawing.Bitmap($size, $size)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear($green)

    $diameter = $size * 0.76
    $border = [Math]::Max(1.5, $size * 0.035)
    $x = ($size - $diameter) / 2
    $g.FillEllipse([Drawing.Brushes]::White, $x, $x, $diameter, $diameter)
    $pen = New-Object Drawing.Pen([Drawing.Color]::Black, $border)
    $g.DrawEllipse($pen, $x + $border / 2, $x + $border / 2, $diameter - $border, $diameter - $border)

    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $family = New-Object Drawing.FontFamily('Arial')
    $path.AddString('db', $family, [int][Drawing.FontStyle]::Regular, $size * 0.42, (New-Object Drawing.PointF(0, 0)), [Drawing.StringFormat]::GenericTypographic)
    $bounds = $path.GetBounds()
    $matrix = New-Object Drawing.Drawing2D.Matrix
    $matrix.Translate(($size - $bounds.Width) / 2 - $bounds.X, ($size - $bounds.Height) / 2 - $bounds.Y)
    $path.Transform($matrix)
    $g.FillPath([Drawing.Brushes]::Black, $path)

    $file = Join-Path $outDir $fileName
    $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $pen.Dispose(); $path.Dispose()
    Write-Output "$fileName ${size}x${size}"
}

New-BuddyIcon 512 'icon-512.png'
New-BuddyIcon 192 'icon-192.png'
New-BuddyIcon 180 'apple-touch-icon.png'
New-BuddyIcon 32 'favicon-32.png'
