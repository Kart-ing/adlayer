import SelfServeForm from "./self-serve-form";

export default function Home() {
  return (
    <>
      <h1>Advertise in the answer layer</h1>
      <p className="lede">
        Agents read <code>llms.txt</code>. AdLayer sells clearly-labeled sponsored placements in it,
        enforces disclosure in code, and then measures whether the label survives the model. Submit a
        creative below; it enters review before it can serve.
      </p>
      <SelfServeForm />
    </>
  );
}
