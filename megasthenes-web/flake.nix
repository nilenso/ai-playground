{
  description = "megasthenes-web development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    litem8.url = "github:neenaoffline/litem8";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      perSystem = { pkgs, system, ... }: {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.sqlite
            pkgs.podman
            pkgs.podman-compose
            inputs.litem8.packages.${system}.default
          ];

          shellHook = ''
            echo "megasthenes-web dev shell"
            echo "  bun $(bun --version)"
            echo "  sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
            echo "  podman-compose available"
            echo "  litem8 available for migrations"
            echo ""
            echo "Run migrations: podman-compose up migrate"
            echo "Dev server:     bun run dev"
          '';
        };
      };
    };
}
