# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 2.0.4 - 2024-05-27

## 2.0.3 - 2024-05-11
Dependencies updates

## 2.0.2 - 2024-04-29
Dictionary schemas integrated

## 2.0.1 - 2024-04-25
Firebase admin connection support

## 2.0.1-beta.1 - 2024-04-23

## 2.0.1-beta.0 - 2024-04-22

## 2.0.0-beta.3 - 2024-04-15

## 2.0.0-beta.2 - 2024-04-15

## 2.0.0-beta.1 - 2024-04-15

## 2.0.0-beta.0 - 2024-04-14

## 1.8.0 - 2024-04-09
Security system

## 1.8.0-beta.1 - 2024-04-09

## 1.8.0-beta.0 - 2024-04-09

## 1.7.2 - 2024-04-02
Dependencies update

## 1.7.1 - 2024-04-01
Bastion host exposed as a construct property

## 1.7.0 - 2024-03-28

## 1.6.1 - 2024-03-27
Dependencies update

## 1.6.0 - 2024-03-25
Dependencies update

## 1.6.0-beta.1 - 2024-03-23

## 1.6.0-beta.0 - 2024-03-23
Custom error handlers from `typizator-handler` supported

## 1.5.0 - 2024-03-22
Documentation updated

### Changed
- `sourceMap` property set to false by default

## 1.5.0-beta.1 - 2024-03-22
### Added
- `customDomainLookupMock` for the custom API domains testing

## 1.5.0-beta.0 - 2024-03-22
### Added
- `vpcProps` configuration properties to override the default VPC settings

## 1.4.0 - 2024-03-22
### Added
- `appDomainData` property in the construct properties allowing to attach the API to a subdomain of an existing domain
- `apiUrl` property of the construct exposing the actual URL for the API access. It can be one created internally by CDK or that of `appDomainData` if it is exposed

## 1.4.0-beta.1 - 2024-03-22
Http URL includes https://

## 1.4.0-beta.0 - 2024-03-22
Http API URL exposed to the construct's users

## 1.3.0-beta.0 - 2024-03-21
Custom domains for HTTP APIs

## 1.2.0 - 2024-03-19
Separate shared layers for dependent constructs. This is needed to avoid layer versions conflicts on separate deployments

## 1.1.0 - 2024-03-17
Dependencies updated and deprecated `members` metadata property usage removed

## 1.0.2 - 2024-03-17
Few documentation updates

## 1.0.1 - 2024-03-17

## 1.0.0 - 2024-03-16
Documented and released
