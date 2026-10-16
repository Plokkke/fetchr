output "container" {
  value = docker_container.fetchr.name
}

output "health_url" {
  value = "http://127.0.0.1:${var.host_port}/health"
}

output "public_url" {
  value = "https://${var.subdomain}.crn-tech.fr"
}
