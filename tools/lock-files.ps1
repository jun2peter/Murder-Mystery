# Encrypt every file in -InputDir into -OutDir as <name>.bin (16-byte IV + AES-256-CBC ciphertext).
# Key = PBKDF2-SHA256(password, random salt). Prints the "lock" JSON to paste into theme.json.
# Pairs with js/locked.js. Usage:
#   powershell -ExecutionPolicy Bypass -File tools\lock-files.ps1 -PasswordFile pw.txt -InputDir src -OutDir themes\x\files
param(
  [Parameter(Mandatory = $true)][string]$PasswordFile,
  [Parameter(Mandatory = $true)][string]$InputDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Iter = 150000
)
$ErrorActionPreference = 'Stop'

$password = ([IO.File]::ReadAllText((Resolve-Path $PasswordFile).Path)).Trim()
$salt = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
$kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new([Text.Encoding]::UTF8.GetBytes($password), $salt, $Iter, [Security.Cryptography.HashAlgorithmName]::SHA256)
$key = $kdf.GetBytes(32)

function Protect-Bytes([byte[]]$data) {
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.Mode = [Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $key
  $aes.GenerateIV()
  $ct = $aes.CreateEncryptor().TransformFinalBlock($data, 0, $data.Length)
  $out = New-Object byte[] (16 + $ct.Length)
  [Array]::Copy($aes.IV, 0, $out, 0, 16)
  [Array]::Copy($ct, 0, $out, 16, $ct.Length)
  return , $out
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem -File $InputDir | ForEach-Object {
  $enc = Protect-Bytes ([IO.File]::ReadAllBytes($_.FullName))
  $dest = Join-Path (Resolve-Path $OutDir).Path ($_.BaseName + '.bin')
  [IO.File]::WriteAllBytes($dest, $enc)
  Write-Host "locked $($_.Name) -> $($_.BaseName).bin"
}
$check = Protect-Bytes ([Text.Encoding]::UTF8.GetBytes('MM-OK'))
[ordered]@{ salt = [Convert]::ToBase64String($salt); iter = $Iter; check = [Convert]::ToBase64String($check) } | ConvertTo-Json -Compress
