# -*- mode: ruby -*-
# vi: set ft=ruby :
Vagrant.configure("2") do |config|
  config.vm.box = "bento/amazonlinux-2"
  config.vm.network :private_network, ip: "192.168.56.6"
  config.vm.provision :shell, :path => ".provision/provision.sh"
  config.vm.synced_folder "./", "/home/vagrant/data", create: true
end
