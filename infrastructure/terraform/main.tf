locals {
  image          = "${var.image_repository}:${var.image_tag}"
  downloads_path = "/downloads"
  # Above SHUTDOWN_TIMEOUT_MS so in-flight downloads are checkpointed before SIGKILL.
  shutdown_timeout_s = 20
}

# Third-party credentials, encrypted in the repository (the deployer provides SOPS_AGE_KEY).
data "sops_file" "secrets" {
  source_file = "${path.module}/../secrets/production.sops.yaml"
}

data "docker_registry_image" "fetchr" {
  name = local.image
}

resource "docker_image" "fetchr" {
  name          = local.image
  pull_triggers = [data.docker_registry_image.fetchr.sha256_digest]
  keep_locally  = true
}

resource "docker_container" "fetchr" {
  name          = "fetchr"
  image         = docker_image.fetchr.image_id
  restart       = "unless-stopped"
  user          = var.run_as
  init          = true
  stop_timeout  = local.shutdown_timeout_s + 10
  security_opts = ["no-new-privileges:true"]

  env = [
    "APP_VERSION=${var.image_tag}",
    "LOG_LEVEL=${var.log_level}",
    "SHUTDOWN_TIMEOUT_MS=${local.shutdown_timeout_s * 1000}",
    "API_KEY=${data.sops_file.secrets.data["api_key"]}",
    "DOWNLOADS_PATH=${local.downloads_path}",
    "HOST_PLUGINS=${join(",", var.host_plugins)}",
    "ARCHIVE_PLUGINS=${join(",", var.archive_plugins)}",
    "ONE_FICHIER_HOST=${var.one_fichier_host}",
    "ONE_FICHIER_API_KEY=${data.sops_file.secrets.data["one_fichier_api_key"]}",
  ]

  ports {
    internal = 3000
    external = var.host_port
    ip       = "127.0.0.1"
  }

  volumes {
    host_path      = var.downloads_host_path
    container_path = local.downloads_path
  }

  log_driver = "json-file"
  log_opts = {
    max-size = "10m"
    max-file = "3"
  }
}

# HTTPS site on the host nginx (certificate included); kept as is when it already exists.
resource "terraform_data" "site" {
  input = { subdomain = var.subdomain, port = var.host_port }

  provisioner "local-exec" {
    command = "[ -e /etc/nginx/sites-available/${self.input.subdomain}.crn-tech.fr ] || sudo /etc/nginx/register-service.sh ${self.input.subdomain} ${self.input.port}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "sudo /etc/nginx/unregister-service.sh ${self.input.subdomain}"
  }

  depends_on = [docker_container.fetchr]
}
