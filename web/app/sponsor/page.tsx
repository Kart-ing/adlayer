import SponsorForm from "./sponsor-form";

export default function Sponsor() {
  return (
    <div className="page">
      <div className="kick">Step 1 of 3</div>
      <h1 className="title">Sponsor a placement</h1>
      <p className="lede">
        Tell us what you&rsquo;re offering. We&rsquo;ll review it for compliance, price it, and — once
        you pay — serve it into a matching publisher&rsquo;s <code>llms.txt</code>.
      </p>

      <div className="steps">
        <span className="step active"><span className="b">1</span> Sponsor</span>
        <span className="sep" />
        <span className="step"><span className="b">2</span> Review &amp; pay</span>
        <span className="sep" />
        <span className="step"><span className="b">3</span> Served in llms.txt</span>
      </div>

      <SponsorForm />
    </div>
  );
}
