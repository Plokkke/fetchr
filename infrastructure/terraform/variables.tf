variable "image_repository" {
  description = "Image repository"
  type        = string
  default     = "ghcr.io/plokkke/fetchr"
}

variable "image_tag" {
  description = "Semantic version to deploy"
  type        = string

  validation {
    condition     = var.image_tag != ""
    error_message = "image_tag is required: deploy a released version."
  }
}

variable "docker_host" {
  description = "Docker API endpoint; the deployer runs on the Raspberry Pi itself"
  type        = string
  default     = "unix:///var/run/docker.sock"
}

variable "subdomain" {
  description = "https://<subdomain>.crn-tech.fr"
  type        = string
  default     = "fetchr"
}

variable "host_port" {
  description = "Loopback port the host nginx proxies to"
  type        = number
  default     = 4004
}

variable "downloads_host_path" {
  description = "Host directory holding the downloads and the state file; on the media disk so consumers can move files without copying"
  type        = string
  default     = "/mnt/disk18to/downloads"
}

variable "run_as" {
  description = "uid:gid owning the downloads, shared with the apps consuming them"
  type        = string
  default     = "1000:1000"
}

variable "host_plugins" {
  type    = list(string)
  default = ["one-fichier", "fetchr-push"]
}

variable "archive_plugins" {
  type    = list(string)
  default = ["zip", "rar"]
}

variable "one_fichier_host" {
  type    = string
  default = "1fichier.com"
}

variable "log_level" {
  type    = string
  default = "info"
}
