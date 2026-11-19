import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';

/**
 * 06-vpc-private-routing: ask a private service which backend a tenant belongs to.
 *
 * Origin: a CloudFront VPC origin in front of an INTERNAL Application Load
 * Balancer. The ALB has no public address at all; CloudFront reaches it over a
 * service-managed network interface inside the VPC. The ALB target is one
 * Lambda function that answers `/route?tenant=<x>` and echoes `/blue/*` and
 * `/green/*`, so the VPC never needs a NAT gateway or an instance.
 */

// CloudFront managed prefix list `com.amazonaws.global.cloudfront.origin-facing`
// in us-east-1 (the only region this app deploys to; it is a different id per region).
// Look it up with: aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'pl-3b927c52';

export const pattern: Pattern = {
  id: 'vpc-private-routing',
  functionCode: path.join(__dirname, 'function.js'),
  // The shared KVS is associated with the function: it holds the kill switch.
  keyValueStore: true,

  origin(scope: Construct): cloudfront.IOrigin {
    // Two AZs (an ALB needs two). VPC origins require an internet gateway to be
    // attached even though nothing routes through it, hence the tiny public
    // subnets. The ALB lives in the isolated subnets; no NAT gateway anywhere.
    const vpc = new ec2.Vpc(scope, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/24'),
      subnetConfiguration: [
        { name: 'igw', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'alb', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 27 },
      ],
    });

    // The routing service and the blue/green echo backends, in one function.
    const service = new lambda.Function(scope, 'Service', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: cdk.Duration.seconds(5),
    });

    const albSecurityGroup = new ec2.SecurityGroup(scope, 'AlbSecurityGroup', {
      vpc,
      description: 'Internal ALB for vpc-private-routing: only CloudFront may connect',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST),
      ec2.Port.tcp(80),
      'CloudFront VPC origin (managed origin-facing prefix list)',
    );

    const alb = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSecurityGroup,
    });
    const listener = alb.addListener('Http', { port: 80, open: false });
    listener.addTargets('Service', {
      targets: [new targets.LambdaTarget(service)],
      healthCheck: { enabled: false },
    });

    // DEMO ONLY: plain HTTP between CloudFront and the ALB, so the sample deploys with no domain.
    // For production, add an HTTPS listener with an ACM certificate for a domain you own, set the
    // protocol policy to HTTPS_ONLY, and point the VPC origin at that listener (see the README).
    return origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      originId: 'vpc-private-routing',
      vpcOriginName: `${cdk.Stack.of(scope).stackName}-vpc-private-routing`,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });
  },
};
