# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
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
