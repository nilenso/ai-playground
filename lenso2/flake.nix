{
  description = "Development environment with Bun";

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
            pkgs.cloudflared
            inputs.litem8.packages.${system}.default
          ];

          shellHook = ''
            echo "Bun $(bun --version) is available"
            echo "litem8 is available for SQLite migrations"
          '';
        };
      };
    };
}
