Get-Content app.js -Raw -Encoding UTF8 | ForEach-Object { $_ -split "`n" } | Select-String -Pattern "perName|perGrupo|perEsp|perPass|maePerfil|perBtn" -AllMatches
