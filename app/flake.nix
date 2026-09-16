{
  description = "Gist development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];
      systems = import inputs.systems;

      perSystem =
        { config, pkgs, ... }:
        {
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              gofmt.enable = true;
              nixfmt.enable = true;
              prettier.enable = true;
            };
            settings.global.excludes = [ "backend/docs/**" ];
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              go
              bun
              go-swag
              golangci-lint
              mockgen
              sqlite
              gopls
              gotools
              config.treefmt.build.wrapper
            ];
          };
        };
    };
}
