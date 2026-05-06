{
  description = "Jadoo development environment";

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
            pkgs.nodejs
            pkgs.biome
            pkgs.sqlite
            pkgs.git
            pkgs.gh
            pkgs.jq
            pkgs.ripgrep
            pkgs.fd
            pkgs.curl
            inputs.litem8.packages.${system}.default
          ];

          shellHook = ''
            echo "jadoo dev shell"
            echo "  bun      $(bun --version)"
            echo "  node     $(node --version)"
            echo "  sqlite3  $(sqlite3 --version | cut -d' ' -f1)"
            echo "  biome    $(biome --version)"
            echo "  litem8   available"
            echo ""
            echo "Common commands:"
            echo "  bun install"
            echo "  bun run dev"
            echo "  bun run test"
            echo "  bun run check"
            echo "  bun run migrate"
          '';
        };
      };
    };
}
