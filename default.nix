{
  lib,
  stdenvNoCC,
  nodejs,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pi-glovebox";
  version = (lib.importJSON ./package.json).version;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bin
      ./extensions
      ./test
      ./README.md
      ./LICENSE
    ];
  };

  buildInputs = [ nodejs ];
  nativeCheckInputs = [ nodejs ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-glovebox $out/bin
    cp -r package.json bin extensions README.md LICENSE $out/share/pi-glovebox/
    ln -s $out/share/pi-glovebox/bin/pi-glovebox-server.mjs $out/bin/pi-glovebox-server
    runHook postInstall
  '';

  meta = {
    description = "Run Pi's bash, read, write and edit tools in a separate sandbox, reached over a Unix socket";
    homepage = "https://github.com/421anon/pi-glovebox";
    license = lib.licenses.mit;
    mainProgram = "pi-glovebox-server";
    platforms = lib.platforms.unix;
  };
})
