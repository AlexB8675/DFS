<#
.SYNOPSIS
  Re-encodes videos in place so they seek fast in DFS's player: AV1 on an
  NVIDIA graphics card (NVENC), with a full frame every 0.5 to 2 seconds.

.DESCRIPTION
  An exact seek decodes every frame from the full frame before the target,
  so the time between full frames sets how long a seek waits. The spacing is
  chosen from the video's resolution and frame rate, so a seek decodes at most
  about as much as 30 frames of 4K: 0.5 s for 4K at 60 fps, 1 s for 4K at
  24-30 fps or 1440p at 60, 2 s for 1080p and below. Measured on a 4K 60 fps
  HDR clip in a browser at 85 Mbit/s, the worst exact seek took 0.9-1.3 s with
  a full frame every 0.5 s, against 4.3-4.5 s with the clip's own 5.6 s.

  Sound, subtitles, chapters, attachments and HDR (colours, mastering display
  and light levels) are kept; only the video is re-encoded. The new file takes
  the old one's name and dates, and the old one goes to the Recycle Bin, or,
  with -KeepOriginal, stays beside it as "<name>.original.<ext>". A file whose
  full frames are already close enough is left alone, unless -Force.

.PARAMETER Path
  One or more .mkv, .webm, .mp4 or .m4v files.

.PARAMETER Quality
  NVENC's constant quality, 0-63, lower is better and bigger (default 36). On
  a 4K HDR test clip from YouTube, 36 made a file 44% smaller than the
  original (PSNR 47 dB against it, alike to the eye); its busiest seconds
  took about 28% more than the original's bit rate, and 40 about the same.

.PARAMETER Interval
  Seconds between full frames, instead of the one chosen.

.PARAMETER Force
  Re-encode even a file whose full frames are already close enough.

.PARAMETER KeepOriginal
  Keep the original beside the new file instead of recycling it.

.EXAMPLE
  dfs-reencode "D:\Videos\Film.mkv"
.EXAMPLE
  dfs-reencode *.mp4 -Quality 40 -KeepOriginal
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Path,
  [ValidateRange(0, 63)][int]$Quality = 36,
  [ValidateRange(0.1, 10)][double]$Interval = 0,
  [switch]$Force,
  [switch]$KeepOriginal
)

$ErrorActionPreference = 'Stop'
# ffprobe writes UTF-8.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Extensions = @('.mkv', '.webm', '.mp4', '.m4v')
# What a seek may decode: 30 frames of 4K.
$DecodeBudget = 3840 * 2160 * 30
$Invariant = [Globalization.CultureInfo]::InvariantCulture

foreach ($tool in 'ffmpeg', 'ffprobe') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool isn't on PATH. Install it with: winget install Gyan.FFmpeg"
  }
}

function Format-Number([double]$value, [string]$format = '0.###') {
  $value.ToString($format, $Invariant)
}

function Read-Probe([string]$file) {
  $json = & ffprobe -v error -print_format json -show_format -show_streams $file
  if ($LASTEXITCODE -ne 0) { throw "ffprobe couldn't read it." }
  ($json -join "`n") | ConvertFrom-Json
}

function Get-FrameRate($stream) {
  foreach ($rate in $stream.avg_frame_rate, $stream.r_frame_rate) {
    if ($rate -match '^(\d+)/(\d+)$' -and [double]$Matches[2] -gt 0) {
      $value = [double]$Matches[1] / [double]$Matches[2]
      if ($value -gt 0 -and $value -le 240) { return $value }
    }
  }
  return 30
}

# The longest time between full frames in the first ten minutes.
function Get-LongestGap([string]$file, [int]$streamIndex) {
  $lines = & ffprobe -v error -read_intervals '%+600' -select_streams $streamIndex `
    -show_entries 'packet=pts_time,flags' -of csv=p=0 $file
  $previous = $null
  $longest = 0.0
  foreach ($line in $lines) {
    $parts = $line.Split(',')
    if ($parts.Count -lt 2 -or -not $parts[1].StartsWith('K')) { continue }
    $time = 0.0
    if (-not [double]::TryParse($parts[0], [Globalization.NumberStyles]::Float, $Invariant, [ref]$time)) { continue }
    if ($null -ne $previous -and ($time - $previous) -gt $longest) { $longest = $time - $previous }
    $previous = $time
  }
  return $longest
}

function Get-VideoStream($probe) {
  $probe.streams | Where-Object { $_.codec_type -eq 'video' -and $_.disposition.attached_pic -ne 1 } |
    Select-Object -First 1
}

function Send-ToRecycleBin([string]$file) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  # All dialogs: Windows asks before deleting outright a file too big for the Recycle Bin.
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $file,
    [Microsoft.VisualBasic.FileIO.UIOption]::AllDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

function Invoke-Reencode([string]$file) {
  $item = Get-Item -LiteralPath $file
  $extension = $item.Extension.ToLowerInvariant()
  if ($Extensions -notcontains $extension) {
    Write-Warning "$($item.Name): only $($Extensions -join ', ') files, skipped."
    return
  }
  $probe = Read-Probe $item.FullName
  $video = Get-VideoStream $probe
  if (-not $video) {
    Write-Warning "$($item.Name): no video, skipped."
    return
  }
  $dolbyVision = $video.side_data_list | Where-Object { $_.side_data_type -eq 'DOVI configuration record' }
  if ($dolbyVision -and $dolbyVision.dv_profile -eq 5) {
    Write-Warning "$($item.Name): Dolby Vision profile 5 has no HDR10 picture to keep, skipped."
    return
  }

  $fps = Get-FrameRate $video
  $every = $Interval
  if ($every -le 0) {
    $affordable = $DecodeBudget / ([double]$video.width * [double]$video.height * $fps)
    $every = 0.5
    foreach ($step in 1, 2) { if ($affordable -ge $step) { $every = $step } }
  }
  $gap = Get-LongestGap $item.FullName $video.index
  $slack = 1.5 / $fps
  if (-not $Force -and $gap -gt 0 -and $gap -le $every + $slack) {
    Write-Host "$($item.Name): full frames already at most $(Format-Number $gap '0.##') s apart, left alone (-Force to re-encode)."
    return
  }

  $duration = [double]::Parse($probe.format.duration, $Invariant)
  Write-Host ("{0}: {1}x{2} at {3} fps, full frames up to {4} s apart now; re-encoding with one every {5} s, quality {6}." -f `
      $item.Name, $video.width, $video.height, (Format-Number $fps '0.##'), (Format-Number $gap '0.##'), (Format-Number $every), $Quality)
  if ($dolbyVision) { Write-Host '  Dolby Vision is dropped; the picture under it (HDR10, HLG or SDR) is kept.' }

  $temporary = Join-Path $item.DirectoryName ($item.BaseName + '.reencoding' + $item.Extension)
  $arguments = @(
    '-hide_banner', '-v', 'error', '-stats', '-nostdin', '-y',
    # Decoded on the graphics card where it can, so the frames stay there.
    '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-i', $item.FullName,
    '-map', '0', '-map', '-0:d', '-c', 'copy',
    # Only the video, not cover art: AV1, a full frame (a real key frame) every $every seconds.
    '-c:V', 'av1_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', "$Quality", '-b:v', '0',
    '-forced-idr', '1', '-force_key_frames', "expr:gte(t,n_forced*$(Format-Number $every))", '-g', '600'
  )
  if ($extension -in '.mp4', '.m4v') { $arguments += @('-movflags', '+faststart') }
  $arguments += $temporary

  $started = Get-Date
  try {
    & ffmpeg @arguments
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed (exit $LASTEXITCODE); the original is untouched." }

    $result = Read-Probe $temporary
    $resultDuration = [double]::Parse($result.format.duration, $Invariant)
    if ([math]::Abs($resultDuration - $duration) -gt [math]::Max(0.5, $duration * 0.002)) {
      throw "The new file lasts $(Format-Number $resultDuration '0.##') s, not $(Format-Number $duration '0.##') s; the original is untouched."
    }
    if (@($result.streams).Count -lt @($probe.streams | Where-Object { $_.codec_type -ne 'data' }).Count) {
      throw 'The new file lost a track; the original is untouched.'
    }
    $newVideo = Get-VideoStream $result
    $newGap = Get-LongestGap $temporary $newVideo.index
    if ($newGap -gt $every + $slack) {
      throw "The new file's full frames are up to $(Format-Number $newGap '0.##') s apart; the original is untouched."
    }

    $new = Get-Item -LiteralPath $temporary
    $new.CreationTime = $item.CreationTime
    $new.LastWriteTime = $item.LastWriteTime
    $oldBytes = $item.Length
    $newBytes = $new.Length
    if ($KeepOriginal) {
      $kept = Join-Path $item.DirectoryName ($item.BaseName + '.original' + $item.Extension)
      Move-Item -LiteralPath $item.FullName -Destination $kept
    } else {
      try {
        Send-ToRecycleBin $item.FullName
      } catch [OperationCanceledException] {
        Write-Warning "Kept the original, so the new file stays as $([IO.Path]::GetFileName($temporary))."
        $temporary = $null
        return
      }
    }
    Move-Item -LiteralPath $temporary -Destination $item.FullName
    $temporary = $null

    $took = (Get-Date) - $started
    $where = if ($KeepOriginal) { "kept as $([IO.Path]::GetFileName($kept))" } else { 'in the Recycle Bin' }
    Write-Host ("  Done in {0:hh\:mm\:ss} ({1}x real time): {2} MB -> {3} MB, full frames up to {4} s apart; the original is {5}." -f `
        $took, (Format-Number ($duration / $took.TotalSeconds) '0.#'), (Format-Number ($oldBytes / 1MB) '0'),
      (Format-Number ($newBytes / 1MB) '0'), (Format-Number $newGap '0.##'), $where)
  } finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
  }
}

$failed = 0
foreach ($pattern in $Path) {
  # A name as given first, as names hold brackets PowerShell would take for a pattern.
  if (Test-Path -LiteralPath $pattern -PathType Leaf) {
    $files = @(Get-Item -LiteralPath $pattern)
  } else {
    $files = @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue)
  }
  if ($files.Count -eq 0) {
    Write-Warning "No file at $pattern."
    $failed += 1
    continue
  }
  foreach ($file in $files) {
    try {
      Invoke-Reencode $file.FullName
    } catch {
      Write-Warning "$($file.Name): $($_.Exception.Message)"
      $failed += 1
    }
  }
}
if ($failed -gt 0) { exit 1 }
