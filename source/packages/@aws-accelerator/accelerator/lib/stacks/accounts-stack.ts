/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import * as path from 'path';

import * as iam from 'aws-cdk-lib/aws-iam';
import { EnablePolicyType, Policy, PolicyAttachment, PolicyType, PolicyTypeEnum } from '@aws-accelerator/constructs';

import { Logger } from '../logger';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';

export interface AccountsStackProps extends AcceleratorStackProps {
  readonly configDirPath: string;
}

export class AccountsStack extends AcceleratorStack {
  readonly cloudwatchKey: cdk.aws_kms.Key;
  readonly lambdaKey: cdk.aws_kms.Key;

  constructor(scope: Construct, id: string, props: AccountsStackProps) {
    super(scope, id, props);

    Logger.debug(`[accounts-stack] Region: ${cdk.Stack.of(this).region}`);

    // Use existing management account CloudWatch log key if in the home region
    // otherwise create new kms key
    if (props.globalConfig.homeRegion == cdk.Stack.of(this).region) {
      this.cloudwatchKey = cdk.aws_kms.Key.fromKeyArn(
        this,
        'AcceleratorGetCloudWatchKey',
        cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_ARN_PARAMETER_NAME,
        ),
      ) as cdk.aws_kms.Key;
    } else {
      this.cloudwatchKey = new cdk.aws_kms.Key(this, 'AcceleratorCloudWatchKey', {
        alias: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_ALIAS,
        description: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_DESCRIPTION,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Allow Cloudwatch logs to use the encryption key
      this.cloudwatchKey.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Cloudwatch logs to use the encryption key`,
          principals: [
            new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.${cdk.Stack.of(this).urlSuffix}`),
          ],
          actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
          resources: ['*'],
          conditions: {
            ArnLike: {
              'kms:EncryptionContext:aws:logs:arn': `arn:${cdk.Stack.of(this).partition}:logs:${
                cdk.Stack.of(this).region
              }:${cdk.Stack.of(this).account}:log-group:*`,
            },
          },
        }),
      );

      new cdk.aws_ssm.StringParameter(this, 'AcceleratorCloudWatchKmsArnParameter', {
        parameterName: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_ARN_PARAMETER_NAME,
        stringValue: this.cloudwatchKey.keyArn,
      });
    }

    // Exactly like CloudWatch key, reference a new key if in home
    // otherwise create new kms key
    if (props.globalConfig.homeRegion == cdk.Stack.of(this).region) {
      this.lambdaKey = cdk.aws_kms.Key.fromKeyArn(
        this,
        'AcceleratorGetLambdaKey',
        cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ARN_PARAMETER_NAME,
        ),
      ) as cdk.aws_kms.Key;
    } else {
      // Create KMS Key for Lambda environment variable encryption
      this.lambdaKey = new cdk.aws_kms.Key(this, 'AcceleratorLambdaKey', {
        alias: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ALIAS,
        description: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_DESCRIPTION,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      new cdk.aws_ssm.StringParameter(this, 'AcceleratorLambdaKmsArnParameter', {
        parameterName: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ARN_PARAMETER_NAME,
        stringValue: this.lambdaKey.keyArn,
      });
    }

    //
    // Global Organizations actions
    //
    if (props.globalRegion === cdk.Stack.of(this).region) {
      if (props.organizationConfig.enable) {
        let quarantineScpId = '';
        // SCP is not supported in China Region.
        if (props.partition !== 'aws-cn') {
          const enablePolicyTypeScp = new EnablePolicyType(this, 'enablePolicyTypeScp', {
            policyType: PolicyTypeEnum.SERVICE_CONTROL_POLICY,
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: props.globalConfig.cloudwatchLogRetentionInDays,
          });

          // Deploy SCPs
          for (const serviceControlPolicy of props.organizationConfig.serviceControlPolicies) {
            Logger.info(`[accounts-stack] Adding service control policy (${serviceControlPolicy.name})`);

            const scp = new Policy(this, serviceControlPolicy.name, {
              description: serviceControlPolicy.description,
              name: serviceControlPolicy.name,
              path: path.join(props.configDirPath, serviceControlPolicy.policy),
              type: PolicyType.SERVICE_CONTROL_POLICY,
              kmsKey: this.cloudwatchKey,
              logRetentionInDays: props.globalConfig.cloudwatchLogRetentionInDays,
              acceleratorPrefix: 'AWSAccelerator',
              managementAccountAccessRole: props.globalConfig.managementAccountAccessRole,
            });
            scp.node.addDependency(enablePolicyTypeScp);

            if (
              serviceControlPolicy.name == props.organizationConfig.quarantineNewAccounts?.scpPolicyName &&
              props.partition == 'aws'
            ) {
              new cdk.aws_ssm.StringParameter(this, pascalCase(`SsmParam${scp.name}ScpPolicyId`), {
                parameterName: `/accelerator/organizations/scp/${scp.name}/id`,
                stringValue: scp.id,
              });
              quarantineScpId = scp.id;
            }

            for (const organizationalUnit of serviceControlPolicy.deploymentTargets.organizationalUnits ?? []) {
              Logger.info(
                `[accounts-stack] Attaching service control policy (${serviceControlPolicy.name}) to organizational unit (${organizationalUnit})`,
              );

              new PolicyAttachment(this, pascalCase(`Attach_${scp.name}_${organizationalUnit}`), {
                policyId: scp.id,
                targetId: props.organizationConfig.getOrganizationalUnitId(organizationalUnit),
                type: PolicyType.SERVICE_CONTROL_POLICY,
                kmsKey: this.cloudwatchKey,
                logRetentionInDays: props.globalConfig.cloudwatchLogRetentionInDays,
              });
            }

            for (const account of serviceControlPolicy.deploymentTargets.accounts ?? []) {
              new PolicyAttachment(this, pascalCase(`Attach_${scp.name}_${account}`), {
                policyId: scp.id,
                targetId: props.accountsConfig.getAccountId(account),
                type: PolicyType.SERVICE_CONTROL_POLICY,
                kmsKey: this.cloudwatchKey,
                logRetentionInDays: props.globalConfig.cloudwatchLogRetentionInDays,
              });
            }
          }
        }

        if (props.securityConfig.accessAnalyzer.enable) {
          Logger.debug('[accounts-stack] Enable Service Access for access-analyzer.amazonaws.com');
          new iam.CfnServiceLinkedRole(this, 'AccessAnalyzerServiceLinkedRole', {
            awsServiceName: 'access-analyzer.amazonaws.com',
          });
        }

        if (props.securityConfig.centralSecurityServices.guardduty.enable) {
          Logger.debug('[accounts-stack] Enable Service Access for guardduty.amazonaws.com');
          new iam.CfnServiceLinkedRole(this, 'GuardDutyServiceLinkedRole', {
            awsServiceName: 'guardduty.amazonaws.com',
            description: 'A service-linked role required for Amazon GuardDuty to access your resources. ',
          });
        }

        if (props.securityConfig.centralSecurityServices.securityHub.enable) {
          Logger.debug('[accounts-stack] Enable Service Access for securityhub.amazonaws.com');
          new iam.CfnServiceLinkedRole(this, 'SecurityHubServiceLinkedRole', {
            awsServiceName: 'securityhub.amazonaws.com',
            description: 'A service-linked role required for AWS Security Hub to access your resources.',
          });
        }

        if (props.securityConfig.centralSecurityServices.macie.enable) {
          Logger.debug('[accounts-stack] Enable Service Access for macie.amazonaws.com');
          new iam.CfnServiceLinkedRole(this, 'MacieServiceLinkedRole', {
            awsServiceName: 'macie.amazonaws.com',
          });
        }

        if (props.organizationConfig.quarantineNewAccounts?.enable === true && props.partition == 'aws') {
          // Create resources to attach quarantine scp to
          // new accounts created in organizations
          Logger.info(`[accounts-stack] Creating resources to quarantine new accounts`);
          const orgPolicyRead = new cdk.aws_iam.PolicyStatement({
            sid: 'OrgRead',
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: ['organizations:ListPolicies', 'organizations:DescribeCreateAccountStatus'],
            resources: ['*'],
          });

          const orgPolicyWrite = new cdk.aws_iam.PolicyStatement({
            sid: 'OrgWrite',
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: ['organizations:AttachPolicy'],
            resources: [
              `arn:${
                this.partition
              }:organizations::${props.accountsConfig.getManagementAccountId()}:policy/o-*/service_control_policy/${quarantineScpId}`,
              `arn:${this.partition}:organizations::${props.accountsConfig.getManagementAccountId()}:account/o-*/*`,
            ],
          });

          Logger.info(`[accounts-stack] Creating function to attach quarantine scp to accounts`);
          const attachQuarantineFunction = new cdk.aws_lambda.Function(this, 'AttachQuarantineScpFunction', {
            code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../lambdas/attach-quarantine-scp/dist')),
            runtime: cdk.aws_lambda.Runtime.NODEJS_14_X,
            handler: 'index.handler',
            description: 'Lambda function to attach quarantine scp to new accounts',
            timeout: cdk.Duration.minutes(5),
            environment: { SCP_POLICY_NAME: props.organizationConfig.quarantineNewAccounts?.scpPolicyName ?? '' },
            environmentEncryption: this.lambdaKey,
            initialPolicy: [orgPolicyRead, orgPolicyWrite],
          });

          // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
          NagSuppressions.addResourceSuppressionsByPath(
            this,
            `${this.stackName}/AttachQuarantineScpFunction/ServiceRole/Resource`,
            [
              {
                id: 'AwsSolutions-IAM4',
                reason: 'AWS Custom resource provider framework-role created by cdk.',
              },
            ],
          );

          // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
          NagSuppressions.addResourceSuppressionsByPath(
            this,
            `${this.stackName}/AttachQuarantineScpFunction/ServiceRole/DefaultPolicy/Resource`,
            [
              {
                id: 'AwsSolutions-IAM5',
                reason: 'Allows only specific policy.',
              },
            ],
          );

          const createAccountEventRule = new cdk.aws_events.Rule(this, 'CreateAccountRule', {
            eventPattern: {
              source: ['aws.organizations'],
              detailType: ['AWS API Call via CloudTrail'],
              detail: {
                eventSource: ['organizations.amazonaws.com'],
                eventName: ['CreateAccount'],
              },
            },
            description: 'Rule to notify when a new account is created.',
          });

          createAccountEventRule.addTarget(
            new cdk.aws_events_targets.LambdaFunction(attachQuarantineFunction, {
              maxEventAge: cdk.Duration.hours(4),
              retryAttempts: 2,
            }),
          );

          //If any GovCloud accounts are configured also
          //watch for any GovCloudCreateAccount events
          if (props.accountsConfig.anyGovCloudAccounts()) {
            Logger.info(
              `[accounts-stack] Creating EventBridge rule to attach quarantine scp to accounts when GovCloud is enabled`,
            );
            const createGovCloudAccountEventRule = new cdk.aws_events.Rule(this, 'CreateGovCloudAccountRule', {
              eventPattern: {
                source: ['aws.organizations'],
                detailType: ['AWS API Call via CloudTrail'],
                detail: {
                  eventSource: ['organizations.amazonaws.com'],
                  eventName: ['CreateGovCloudAccount'],
                },
              },
              description: 'Rule to notify when a new account is created using the create govcloud account api.',
            });

            createGovCloudAccountEventRule.addTarget(
              new cdk.aws_events_targets.LambdaFunction(attachQuarantineFunction, {
                maxEventAge: cdk.Duration.hours(4),
                retryAttempts: 2,
              }),
            );
          }

          new cdk.aws_logs.LogGroup(this, `${attachQuarantineFunction.node.id}LogGroup`, {
            logGroupName: `/aws/lambda/${attachQuarantineFunction.functionName}`,
            retention: props.globalConfig.cloudwatchLogRetentionInDays,
            encryptionKey: this.cloudwatchKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          });
        }
      }
    }
    Logger.info('[accounts-stack] Completed stack synthesis');
  }
}
