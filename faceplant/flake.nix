{
  description = "Faceplant - single binary local observability stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "faceplant";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.zig pkgs.pkg-config ];
          buildInputs = [ pkgs.sqlite ];
          buildPhase = ''
            export HOME=$TMPDIR
            zig build -Doptimize=ReleaseSafe
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/faceplant $out/bin/faceplant
          '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/faceplant";
        };

        apps.test = {
          type = "app";
          program = toString (pkgs.writeShellScript "faceplant-test" ''
            set -euo pipefail
            export HOME="${"$"}TMPDIR"
            ${pkgs.zig}/bin/zig test \
              -I ${pkgs.sqlite.dev}/include \
              -L ${pkgs.sqlite.out}/lib \
              -lsqlite3 \
              -lc \
              src/main.zig
          '');
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.zig
            pkgs.zls
            pkgs.sqlite
            pkgs.pkg-config
            pkgs.curl
            pkgs.jq
          ];
        };
      });
}
