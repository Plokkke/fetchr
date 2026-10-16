terraform {
  required_version = ">= 1.10"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
    sops = {
      source  = "carlpett/sops"
      version = "~> 1.1"
    }
  }

  # State lives in the home server's shared Postgres; the deployer provides PG_CONN_STR.
  backend "pg" {
    schema_name = "fetchr"
  }
}

# Public image: no registry credentials.
provider "docker" {
  host = var.docker_host
}
